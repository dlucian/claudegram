// Durable queue for inbound `notifications/claude/channel` messages.
//
// A pure module: it imports only Node built-ins, takes paths and callbacks as
// arguments, and never reads `process.env`, so tests can import it without
// starting the bot. server.ts wires it to the live state directory.
//
// Every message follows one path: append a line to the queue file, send the
// head of the file, and remove that line by identity once the send resolves.
// The removal re-reads the file and never rewrites from an earlier snapshot,
// so a line appended during a pending send survives.

import { randomUUID } from 'crypto'
import {
  appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'fs'
import { basename, dirname, join } from 'path'

/**
 * How long server.ts waits after startup before the first flush. A
 * notification sent before the harness registers its channel handler probably
 * disappears, even though `mcp.notification` resolves. This is an estimate:
 * the demo on the live session checks it.
 */
export const BOOT_GRACE_MS = 10_000

export type Notification = { method: string; params: unknown }
export type QueueEntry = { key: string; line: string; notification: Notification; queuedAt?: string }
type Log = (message: string) => void

/** Quarantine appends whose queue-side removal failed, so a retry doesn't append the line again. */
const quarantined = new Set<string>()

type Parsed = { key: string; notification: Notification; queuedAt?: string }

/**
 * Parses one queue line. Returns null unless the line is a JSON object whose
 * `method` is a `notifications/` string and whose `params`, when present, is
 * an object. Wrong methods and bad params would otherwise be sent unseen or
 * rejected on every flush.
 */
function parseLine(line: string): Parsed | null {
  let value: unknown
  try { value = JSON.parse(line) } catch { return null }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { _id, _queuedAt, ...notification } = value as Record<string, unknown>
  const method = notification.method
  if (typeof method !== 'string' || !method.startsWith('notifications/')) return null
  if ('params' in notification) {
    const params = notification.params
    if (typeof params !== 'object' || params === null || Array.isArray(params)) return null
  }
  return {
    key: typeof _id === 'string' && _id.length > 0 ? _id : line,
    notification: notification as Notification,
    ...(typeof _queuedAt === 'string' ? { queuedAt: _queuedAt } : {}),
  }
}

/**
 * Appends `notification` as one line and returns its `_id`. Throws on a write
 * failure, so the caller can send directly.
 *
 * The leading newline keeps a line torn by a failed write from merging with
 * this one. Blank lines are harmless, because every reader drops them.
 */
export function appendEntry(path: string, notification: Notification): string {
  const _id = randomUUID()
  const line = JSON.stringify({ ...notification, _id, _queuedAt: new Date().toISOString() })
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  appendFileSync(path, '\n' + line + '\n', { mode: 0o600 })
  return _id
}

/**
 * Rewrites the queue file without the first line that `drop` selects, from a
 * fresh read, with no await between the read and the rename. Lines that don't
 * parse stay verbatim. Throws on a write failure.
 */
function rewriteWithout(path: string, drop: (line: string) => boolean): void {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  const lines = raw.split('\n').filter(l => l.trim().length > 0)
  const index = lines.findIndex(drop)
  if (index === -1) return
  lines.splice(index, 1)
  if (lines.length === 0) {
    rmSync(path, { force: true })
    return
  }
  const tmp = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600 })
    renameSync(tmp, path)
  } catch (err) {
    try { rmSync(tmp, { force: true }) } catch {}
    throw err
  }
}

/** Removes the first entry whose key matches. Throws on a write failure. */
export function removeEntry(path: string, key: string): void {
  rewriteWithout(path, line => parseLine(line)?.key === key)
}

/**
 * Returns the deliverable entries in file order. An unparsable line moves to
 * `corruptPath` and never blocks the entries after it. Logs only file names
 * and counts, never a line, because a line can hold a private message.
 */
export function readEntries(path: string, corruptPath: string, log: Log): QueueEntry[] {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log(`cannot read ${basename(path)}: ${(err as NodeJS.ErrnoException).code ?? 'error'}`)
    }
    return []
  }
  const entries: QueueEntry[] = []
  let moved = 0
  let failed = 0
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue
    const parsed = parseLine(line)
    if (parsed) {
      entries.push({ line, ...parsed })
      continue
    }
    const marker = `${corruptPath}\n${line}`
    try {
      if (!quarantined.has(marker)) {
        appendFileSync(corruptPath, line + '\n', { mode: 0o600 })
        quarantined.add(marker)
      }
      rewriteWithout(path, l => l === line)
      quarantined.delete(marker)
      moved++
    } catch {
      failed++
    }
  }
  if (moved > 0) log(`moved ${moved} unparsable line(s) from ${basename(path)} to ${basename(corruptPath)}`)
  if (failed > 0) log(`could not quarantine ${failed} unparsable line(s) in ${basename(path)}; delivery continues`)
  return entries
}

/**
 * Deletes `<path>.tmp-<pid>` files that a crash left behind between the write
 * and the rename in `rewriteWithout`. They hold private messages. A file whose
 * process is still alive belongs to that process, so it stays.
 */
function sweepStaleTemp(path: string, log: Log): void {
  const prefix = `${basename(path)}.tmp-`
  let names: string[]
  try { names = readdirSync(dirname(path)) } catch { return }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const pid = Number(name.slice(prefix.length))
    if (!Number.isInteger(pid) || pid <= 0) continue
    if (pid !== process.pid) {
      try { process.kill(pid, 0); continue } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') continue
      }
    }
    try {
      rmSync(join(dirname(path), name), { force: true })
      log(`removed stale temp file ${name}`)
    } catch {}
  }
}

export function createQueue(opts: {
  path: string
  corruptPath: string
  send: (notification: Notification) => Promise<unknown>
  log: Log
}): { enqueue(n: Notification): Promise<void>; flush(): Promise<void>; open(): void } {
  const { path, corruptPath, send, log } = opts
  let isOpen = false
  let running = false
  let again = false

  /** Sends head entries until none remain or one fails. Never throws. */
  async function drain(): Promise<void> {
    for (;;) {
      let head: QueueEntry | undefined
      try {
        head = readEntries(path, corruptPath, log)[0]
      } catch (err) {
        log(`cannot read the notification queue: ${err}`)
        return
      }
      if (!head) return
      try {
        await send(head.notification)
      } catch (err) {
        log(`MCP unreachable, kept queued notification (${err})`)
        return
      }
      try {
        removeEntry(path, head.key)
      } catch (err) {
        log(`cannot remove a delivered notification, it will be sent again: ${err}`)
        return
      }
    }
  }

  async function flush(): Promise<void> {
    if (!isOpen) return
    if (running) {
      // The running loop re-reads the file before each send, so it picks up an
      // appended line. If it stops on a failure first, `again` runs one more
      // pass, so a request made during the failing flush isn't lost.
      again = true
      return
    }
    running = true
    try {
      do {
        again = false
        await drain()
      } while (again)
    } catch (err) {
      log(`flush failed: ${err}`)
    } finally {
      running = false
    }
  }

  return {
    async enqueue(n) {
      try {
        appendEntry(path, n)
      } catch (err) {
        log(`failed to queue notification, sending directly: ${err}`)
        try {
          await send(n)
        } catch (sendErr) {
          log(`direct send failed, notification lost: ${sendErr}`)
        }
        return
      }
      await flush()
    },
    flush,
    open() {
      if (isOpen) return
      isOpen = true
      sweepStaleTemp(path, log)
      void flush()
    },
  }
}
