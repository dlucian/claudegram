// Durable queue for inbound `notifications/claude/channel` messages.
//
// A pure module: it imports only Node built-ins, takes paths and callbacks as
// arguments, and never reads `process.env`, so tests can import it without
// starting the bot. server.ts wires it to the live state directory.
//
// Every message follows one path: append a line to the queue file, then let
// `pump` decide when to send the head of the file and when to remove it.
//
// With a session-state reader (hooks/session-state.sh writes the state), the
// queue holds the head until the session is idle, sends one entry, and keeps
// that entry until the turn it started ends. A send that resolves proves
// nothing: the harness can drop a notification that arrives before it
// registers its channel handler, so only an `idle` write later than the send
// removes the entry. Every uncertain state fails toward delivery.
//
// Without a state reader, or while the kill switch is on, every entry is sent
// and removed at once. A removal re-reads the file and never rewrites from an
// earlier snapshot, so a line appended during a pending send survives.

import { randomUUID } from 'crypto'
import {
  appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync,
  renameSync, rmSync, statSync, writeFileSync, writeSync,
} from 'fs'
import { basename, dirname, join } from 'path'

/**
 * How long server.ts waits after startup before the first pump. A notification
 * sent before the harness registers its channel handler can disappear, even
 * though `mcp.notification` resolves. The harness registers the handler in an
 * effect that runs after the MCP client reports `connected`, and the SDK offers
 * no signal for it, so this is an estimate. The queue keeps an entry until its
 * turn ends, which covers a notification that is lost anyway.
 */
export const BOOT_GRACE_MS = 10_000

/** How often the queue file is checked for work. */
export const POLL_MS = 1_000
/** How long the state must stay `idle` before the head is sent. */
export const SETTLE_MS = 3_000
/** A `busy` marker not rewritten for this long no longer counts. A foreground Bash call can stay silent for 600 s. */
export const STALE_BUSY_MS = 900_000
/** The longest a message waits under a fresh `busy` marker, and the longest an entry stays in flight. */
export const MAX_HOLD_MS = 1_800_000
/** How long a sent entry waits for any state write before it is sent again. */
export const ACK_TIMEOUT_MS = 30_000
/** Spacing between entries released because the marker is stale or the hold cap passed. */
export const FAIL_OPEN_SPACING_MS = 30_000
/** The most times one entry is sent without the session starting a turn. */
export const MAX_ATTEMPTS = 3
/** A send that has not settled by now counts as rejected. */
export const SEND_TIMEOUT_MS = 15_000
/** The wait before a poll tick retries a rejected send. */
export const SEND_RETRY_MS = 5_000
/** The reaction on a held message. It is on Telegram's reaction allowlist. */
export const QUEUED_REACTION = '🫡'

export type SessionState = { state: 'busy' | 'idle'; mtimeMs: number }

/**
 * Reads `<stateDir>/session-state/<pid>`. Returns null when the file is
 * missing, unreadable, or holds anything but `busy` or `idle`, and the caller
 * delivers. The word and the mtime come from one open file, so they cannot
 * belong to two different writes.
 */
export function readSessionState(stateDir: string, pid: number | null): SessionState | null {
  if (pid === null || !Number.isInteger(pid) || pid <= 1) return null
  let fd: number | undefined
  try {
    fd = openSync(join(stateDir, 'session-state', String(pid)), 'r')
    const { mtimeMs } = fstatSync(fd)
    const buf = Buffer.alloc(32)
    const n = readSync(fd, buf, 0, buf.length, 0)
    const word = buf.toString('utf8', 0, n).trim()
    return word === 'busy' || word === 'idle' ? { state: word, mtimeMs } : null
  } catch {
    return null
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch {}
  }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Deletes state files whose process is dead, and temp files that a crashed
 * hook left behind. Returns how many it removed.
 */
export function sweepDeadStateFiles(
  stateDir: string,
  log: Log,
  isAlive: (pid: number) => boolean = pidAlive,
  nowMs: number = Date.now(),
): number {
  const dir = join(stateDir, 'session-state')
  let names: string[]
  try { names = readdirSync(dir) } catch { return 0 }
  let removed = 0
  for (const name of names) {
    const file = join(dir, name)
    if (/^\d+$/.test(name)) {
      if (isAlive(Number(name))) continue
    } else if (name.startsWith('.') && name.endsWith('.tmp')) {
      try { if (nowMs - statSync(file).mtimeMs < 60_000) continue } catch { continue }
    } else {
      continue
    }
    try { rmSync(file, { force: true }); removed++ } catch {}
  }
  if (removed > 0) log(`removed ${removed} stale session-state file(s)`)
  return removed
}

export type Notification = { method: string; params: unknown }
export type QueueEntry = {
  key: string
  line: string
  notification: Notification
  queuedAt?: string
  /** Times an earlier or the current process sent this entry without seeing its turn end. */
  attempts?: number
  /** True when the line carries an `_id`, so its key is stable under a rewrite. */
  hasId: boolean
}
type Log = (message: string) => void

/** Quarantine appends whose queue-side removal failed, so a retry doesn't append the line again. */
const quarantined = new Set<string>()

type Parsed = { key: string; notification: Notification; queuedAt?: string; attempts?: number; hasId: boolean }

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
  const { _id, _queuedAt, _attempts, ...notification } = value as Record<string, unknown>
  const method = notification.method
  if (typeof method !== 'string' || !method.startsWith('notifications/')) return null
  if ('params' in notification) {
    const params = notification.params
    if (typeof params !== 'object' || params === null || Array.isArray(params)) return null
  }
  return {
    key: typeof _id === 'string' && _id.length > 0 ? _id : line,
    notification: notification as Notification,
    hasId: typeof _id === 'string' && _id.length > 0,
    ...(typeof _queuedAt === 'string' ? { queuedAt: _queuedAt } : {}),
    ...(typeof _attempts === 'number' && Number.isInteger(_attempts) && _attempts >= 0 ? { attempts: _attempts } : {}),
  }
}

/** How long a writer waits for the queue lock before it goes ahead without it. */
export const LOCK_WAIT_MS = 200
/** A lock file older than this is a leftover from a crashed process and gets broken. */
export const LOCK_STALE_MS = 2_000
const LOCK_POLL_MS = 2

/**
 * Blocks the thread for about `ms`. Under Bun, `Atomics.wait` overshoots a
 * short wait by a factor of ten or more (5 ms took 39 ms), so use
 * `Bun.sleepSync`, which overshoots less.
 */
function sleepSync(ms: number): void {
  const bun = (globalThis as { Bun?: { sleepSync(ms: number): void } }).Bun
  if (bun) bun.sleepSync(ms)
  else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Takes `<path>` with `O_EXCL` and returns the function that releases it. The
 * lock FAILS OPEN: when it is busy past `LOCK_WAIT_MS`, or cannot be created,
 * it logs and returns a no-op release, because a stuck lock must never keep an
 * inbound message out of the queue. A lock file older than `LOCK_STALE_MS` is
 * broken. Two processes that break the same stale lock at once can still
 * overlap, which is the unlocked behavior and nothing worse.
 */
function acquireLock(lockPath: string, log: Log): () => void {
  const token = `${process.pid}.${randomUUID()}`
  const deadline = Date.now() + LOCK_WAIT_MS
  for (let first = true; ; first = false) {
    if (!first && Date.now() >= deadline) {
      log(`queue lock ${basename(lockPath)} stayed busy for ${LOCK_WAIT_MS} ms; continuing without it`)
      return () => {}
    }
    try {
      const fd = openSync(lockPath, 'wx', 0o600)
      try {
        writeSync(fd, token)
      } catch {
        closeSync(fd)
        try { rmSync(lockPath, { force: true }) } catch {}
        return () => {}
      }
      closeSync(fd)
      return () => {
        // Remove the lock only while it is still ours: a stale-lock breaker may have replaced it.
        try { if (readFileSync(lockPath, 'utf8') === token) rmSync(lockPath, { force: true }) } catch {}
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return () => {} // no queue directory yet, so nothing to protect
      if (code !== 'EEXIST') {
        log(`cannot take the queue lock (${code ?? 'error'}); continuing without it`)
        return () => {}
      }
      try {
        if (Date.now() - statSync(lockPath).mtimeMs >= LOCK_STALE_MS) {
          rmSync(lockPath, { force: true })
          continue
        }
      } catch {
        continue // the holder released it between our attempts
      }
    }
    sleepSync(LOCK_POLL_MS)
  }
}

/** Runs `fn` while holding the queue's cross-process lock. The lock is released on every exit, including a throw. */
export function withQueueLock<T>(path: string, log: Log, fn: () => T): T {
  const release = acquireLock(`${path}.lock`, log)
  try {
    return fn()
  } finally {
    release()
  }
}

/**
 * Appends `notification` as one line and returns its `_id`. Throws on a write
 * failure, so the caller can send directly.
 *
 * The leading newline keeps a line torn by a failed write from merging with
 * this one. Blank lines are harmless, because every reader drops them.
 */
export function appendEntry(
  path: string,
  notification: Notification,
  nowMs: number = Date.now(),
  log: Log = () => {},
): string {
  const _id = randomUUID()
  const line = JSON.stringify({ ...notification, _id, _queuedAt: new Date(nowMs).toISOString() })
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  withQueueLock(path, log, () => appendFileSync(path, '\n' + line + '\n', { mode: 0o600 }))
  return _id
}

/**
 * Rewrites the queue file from a fresh read, with no await between the read
 * and the rename, while holding the queue lock so an append from another
 * process can't land between them and be erased. `edit` sees each line in order: the first line for which it
 * returns a string is replaced by that string, or removed when it returns null.
 * Lines that don't parse stay verbatim. Throws on a write failure.
 */
function rewriteLines(
  path: string,
  edit: (line: string) => string | null | undefined,
  log: Log = () => {},
): void {
  withQueueLock(path, log, () => rewriteLocked(path, edit))
}

function rewriteLocked(path: string, edit: (line: string) => string | null | undefined): void {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  const lines = raw.split('\n').filter(l => l.trim().length > 0)
  let index = -1
  let replacement: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const r = edit(lines[i]!)
    if (r !== undefined) {
      index = i
      replacement = r
      break
    }
  }
  if (index === -1) return
  if (replacement === null) lines.splice(index, 1)
  else lines[index] = replacement
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

function rewriteWithout(path: string, drop: (line: string) => boolean, log: Log = () => {}): void {
  rewriteLines(path, line => (drop(line) ? null : undefined), log)
}

/**
 * Records how many times the entry was sent, so a restart can't reset the
 * count. A line without an `_id` has no stable key, so it is left alone.
 * Throws on a write failure.
 */
export function setAttempts(path: string, key: string, attempts: number, log: Log = () => {}): void {
  rewriteLines(path, line => {
    const parsed = parseLine(line)
    if (!parsed?.hasId || parsed.key !== key) return undefined
    return JSON.stringify({ ...(JSON.parse(line) as Record<string, unknown>), _attempts: attempts })
  }, log)
}

/** Removes the first entry whose key matches. Throws on a write failure. */
export function removeEntry(path: string, key: string, log: Log = () => {}): void {
  rewriteWithout(path, line => parseLine(line)?.key === key, log)
}

/**
 * Returns the deliverable entries in file order. An unparsable line moves to
 * `corruptPath` and never blocks the entries after it. Logs only file names
 * and counts, never a line, because a line can hold a private message.
 */
export function readEntries(path: string, corruptPath: string, log: Log): QueueEntry[] {
  return loadEntries(path, corruptPath, log) ?? []
}

/**
 * Like `readEntries`, but returns null when the file exists and can't be read.
 * A missing or empty file is a positively empty queue; a read failure says
 * nothing about the queue, so the caller must not act on it as if it were empty.
 */
function loadEntries(path: string, corruptPath: string, log: Log): QueueEntry[] | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    log(`cannot read ${basename(path)}: ${(err as NodeJS.ErrnoException).code ?? 'error'}`)
    return null
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
      rewriteWithout(path, l => l === line, log)
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


export type Queue = {
  /**
   * Appends the notification and runs the loop. Returns `sent` when the entry went out during this call, `held` otherwise.
   * When the loop is already running, it returns `held` at once instead of waiting behind a slow send; the running loop
   * picks the entry up, so a caller that marks a held entry must tolerate the release arriving first.
   */
  enqueue(n: Notification): Promise<'sent' | 'held'>
  /** Runs the loop and resolves when it stops. */
  pump(): Promise<void>
  /** Same as `pump`; the name predates the hold logic. */
  flush(): Promise<void>
  /** Starts delivery and the poll timer. */
  open(): void
  /** Stops the poll timer and all delivery. */
  close(): void
  /** How many entries wait in the file, and whether the head was sent and awaits the end of its turn. */
  stats(): { depth: number; inFlight: boolean }
}

export type QueueOptions = {
  path: string
  corruptPath: string
  send: (notification: Notification) => Promise<unknown>
  log: Log
  /**
   * Returns the session's busy or idle word, or null when it is missing or
   * unreadable. Without it, every entry is sent and removed at once.
   */
  readState?: () => SessionState | null
  /** True while the kill switch is on. Every entry is then sent and removed at once. */
  disabled?: () => boolean
  /** False when another process owns the bot. That process delivers, this one only appends. Defaults to true. */
  isOwner?: () => boolean
  /** Tells the user an entry was dropped after `MAX_ATTEMPTS` sends. A rejection is logged and never blocks the queue. */
  warn?: (entry: QueueEntry, text: string) => Promise<unknown>
  /**
   * Runs after a send resolves, for example to clear the queued reaction. A rejected send never runs it, so the
   * marker stays while the entry stays queued. A send that timed out and resolves late runs it then. `fresh` is
   * true when the entry was appended by the `enqueue` call that is releasing it, so it never waited and has no
   * queued marker. A rejection is logged and never blocks the queue.
   */
  onRelease?: (notification: Notification, info: { fresh: boolean }) => Promise<unknown>
  now?: () => number
  /** How long a send may take before the entry counts as in flight, uncertain. Defaults to `SEND_TIMEOUT_MS`. */
  sendTimeoutMs?: number
  /** Poll interval. Zero, the default, runs no timer. */
  pollMs?: number
}

type Flight = { key: string; sentAt: number; attempts: number }

/** A send that timed out. Its promise can still settle, so the entry's delivery is uncertain. */
type TimedOut = { key: string; at: number; state: 'pending' | 'ok' | 'failed' }

type SendResult =
  | { kind: 'sent'; sentAt: number }
  | { kind: 'uncertain'; sentAt: number } // timed out; the original send may still deliver
  | { kind: 'failed' } // rejected; the head stays and the tick retries after a wait
  | { kind: 'held' } // the recheck found the session busy; nothing was sent

class SendTimeout extends Error {
  constructor(readonly what: string, readonly ms: number) {
    super(`${what} timed out after ${ms} ms`)
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SendTimeout(what, ms)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

export function createQueue(opts: QueueOptions): Queue {
  const { path, corruptPath, send, log } = opts
  const now = opts.now ?? Date.now
  let isOpen = false
  let closed = false
  let timer: ReturnType<typeof setInterval> | undefined
  let current: Promise<void> | null = null
  let again = false

  /** Keys this process appended. Any other entry came from an earlier process. */
  const ownKeys = new Set<string>()
  const sentKeys = new Set<string>()
  /** True once a state file was read, which proves the hooks run. */
  let sawState = false
  /** The head that was sent and awaits the end of its turn. In memory only: a restart never trusts an earlier process's send time. */
  let flight: Flight | null = null
  /** A delivered head whose removal failed. It is never sent again. */
  let removeOnly: string | null = null
  let lastFailOpenAt = -Infinity
  /** The latest send that timed out, until it settles and its outcome is used. */
  let timedOut: TimedOut | null = null
  let blockedUntil = 0
  /** The key that the running `enqueue` call appended, while that call runs the loop itself. */
  let appendedKey: string | null = null

  function remember(set: Set<string>, key: string): void {
    set.add(key)
    if (set.size > 512) set.delete(set.values().next().value as string)
  }

  function removeHead(head: QueueEntry): boolean {
    try {
      removeEntry(path, head.key, log)
      return true
    } catch (err) {
      log(`cannot remove a delivered notification, it will be sent again: ${err}`)
      return false
    }
  }

  /**
   * Sends the head once. `persist` records the send count in the queue line, for an entry that stays queued.
   *
   * `stillOk` re-reads the marker as the last step before the send. When it returns false, a terminal prompt or
   * another turn started since the decision, so the entry stays queued and nothing is sent. A turn that starts
   * between this check and the send can still absorb the message; the window is a few microtasks, and no check
   * closes it.
   *
   * The release hook (which clears the queued reaction) runs only after the send resolves, so a rejected or
   * timed-out send leaves the reaction on. A timed-out send is uncertain, not failed: the original promise can
   * still deliver, so the result is `uncertain` and the caller keeps the entry in flight. When that promise
   * resolves late, the release hook runs then.
   */
  async function sendHead(
    head: QueueEntry,
    attempts: number,
    persist: boolean,
    stillOk?: () => boolean,
  ): Promise<SendResult> {
    if (stillOk && !stillOk()) return { kind: 'held' }
    const fresh = head.key === appendedKey
    // Taken before the send: a hook can write the state while the send awaits.
    const sentAt = now()
    let sending: Promise<unknown>
    try {
      sending = Promise.resolve(send(head.notification))
    } catch (err) {
      sending = Promise.reject(err)
    }
    const record = (): void => {
      remember(sentKeys, head.key)
      if (persist) {
        try {
          setAttempts(path, head.key, attempts, log)
        } catch (err) {
          log(`cannot record the send count: ${err}`)
        }
      }
    }
    try {
      await withTimeout(sending, opts.sendTimeoutMs ?? SEND_TIMEOUT_MS, 'send')
    } catch (err) {
      if (!(err instanceof SendTimeout)) {
        blockedUntil = now() + SEND_RETRY_MS
        log(`MCP unreachable, kept queued notification (${err})`)
        return { kind: 'failed' }
      }
      log(`send still pending after ${err.ms} ms, treating the entry as in flight (${head.key.slice(0, 8)})`)
      const mine: TimedOut = { key: head.key, at: now(), state: 'pending' }
      timedOut = mine
      sending.then(
        () => {
          mine.state = 'ok'
          record() // late delivery: count it, and release the entry's marker
          void releaseHook(head, fresh)
        },
        late => {
          mine.state = 'failed'
          log(`the send that timed out then failed (${late})`)
        },
      )
      // The attempt counts now, so a restart can't lose track of a send that may deliver.
      if (persist) {
        try {
          setAttempts(path, head.key, attempts, log)
        } catch (e) {
          log(`cannot record the send count: ${e}`)
        }
      }
      return { kind: 'uncertain', sentAt }
    }
    record()
    await releaseHook(head, fresh)
    return { kind: 'sent', sentAt }
  }

  async function releaseHook(head: QueueEntry, fresh: boolean): Promise<void> {
    if (!opts.onRelease) return
    try {
      await withTimeout(opts.onRelease(head.notification, { fresh }), 3_000, 'release hook')
    } catch (err) {
      log(`release hook failed: ${err}`)
    }
  }

  async function giveUp(head: QueueEntry): Promise<boolean> {
    const meta = (head.notification.params as { meta?: Record<string, unknown> } | undefined)?.meta
    const id = typeof meta?.message_id === 'string' ? `message ${meta.message_id}` : `entry ${head.key.slice(0, 8)}`
    log(`${id} was sent ${MAX_ATTEMPTS} times and no turn started, dropped from the queue`)
    if (opts.warn) {
      try {
        await withTimeout(
          opts.warn(head, `The session did not start a turn for ${id} after ${MAX_ATTEMPTS} tries. It is dropped from the queue; send it again if it still matters.`),
          5_000,
          'warning',
        )
      } catch (err) {
        log(`cannot send the dropped-message warning: ${err}`)
      }
    }
    flight = null
    if (removeHead(head)) return true
    // The warning is out. Later passes retry only the removal, never the warning.
    removeOnly = head.key
    return false
  }

  /** Sends head entries until none remain or one fails. Used when nothing gates delivery. */
  async function passUngated(head: QueueEntry): Promise<boolean> {
    if (flight?.key === head.key) {
      // The kill switch came on while the head awaited its turn: its delivery is done.
      flight = null
      return removeAfterDelivery(head)
    }
    if (timedOut?.key === head.key) {
      const t = timedOut
      // An earlier send timed out. If it has since delivered, the entry is done. If it is still pending, wait for it
      // until the retry rule expires it, so two sends of one entry never overlap.
      if (t.state === 'ok') {
        timedOut = null
        return removeAfterDelivery(head)
      }
      if (t.state === 'pending' && now() - t.at < ACK_TIMEOUT_MS) return false
      timedOut = null
    }
    const result = await sendHead(head, (head.attempts ?? 0) + 1, false)
    if (result.kind === 'failed' || result.kind === 'held' || result.kind === 'uncertain') return false
    return removeAfterDelivery(head)
  }

  /** Removes a delivered head. A failed removal is retried alone, so the entry is never sent a second time. */
  function removeAfterDelivery(head: QueueEntry): boolean {
    if (removeHead(head)) return true
    removeOnly = head.key
    return false
  }

  function readStateSafe(): SessionState | null {
    try { return opts.readState!() } catch { return null }
  }

  /** Whether the head may leave the queue now, given the marker: send, send under the fail-open rule, or hold. */
  function decideRelease(head: QueueEntry, state: SessionState | null, t: number): 'now' | 'fail-open' | 'hold' {
    if (state === null) return 'now'
    if (state.state === 'idle') return t - state.mtimeMs >= SETTLE_MS ? 'now' : 'hold'
    const queuedMs = head.queuedAt ? Date.parse(head.queuedAt) : NaN
    const capExpired = !(t - queuedMs < MAX_HOLD_MS)
    return t - state.mtimeMs >= STALE_BUSY_MS || capExpired ? 'fail-open' : 'hold'
  }

  /** One decision about the head. Returns true when the loop can look at the next entry. */
  async function passGated(head: QueueEntry, state: SessionState | null): Promise<boolean> {
    const t = now()

    if (flight && flight.key !== head.key) flight = null

    if (flight) {
      const f = flight
      const ended = state !== null && state.state === 'idle' && state.mtimeMs > f.sentAt
      const stale = state !== null && state.state === 'busy' && t - state.mtimeMs >= STALE_BUSY_MS
      const held = t - f.sentAt >= MAX_HOLD_MS
      if (ended || stale || held) {
        flight = null
        return removeAfterDelivery(head)
      }
      const acked = state !== null && state.mtimeMs > f.sentAt
      if (acked || t - f.sentAt < ACK_TIMEOUT_MS) return false
      // The session wrote nothing since the send: the notification probably never became a turn.
      if (f.attempts >= MAX_ATTEMPTS) return giveUp(head)
      const result = await sendHead(head, f.attempts + 1, true, () => {
        const latest = readStateSafe()
        return !(latest !== null && latest.mtimeMs > f.sentAt) // a state write since the send is an acknowledgement
      })
      if (result.kind === 'sent' || result.kind === 'uncertain') {
        flight = { key: head.key, sentAt: result.sentAt, attempts: f.attempts + 1 }
      }
      return false
    }

    if ((head.attempts ?? 0) >= MAX_ATTEMPTS) return giveUp(head)

    let release = decideRelease(head, state, t)
    if (release === 'fail-open' && t - lastFailOpenAt < FAIL_OPEN_SPACING_MS) release = 'hold'
    if (release === 'hold') return false

    // An entry that an earlier process persisted proves the hooks ran there; a fresh one needs a state file here.
    const track = release === 'now' && (state !== null || sawState || !ownKeys.has(head.key))
    const attempts = (head.attempts ?? 0) + 1
    const result = await sendHead(head, attempts, track, () => decideRelease(head, readStateSafe(), now()) !== 'hold')
    if (result.kind === 'failed' || result.kind === 'held') return false
    if (release === 'fail-open') lastFailOpenAt = t
    // A send that timed out is in flight even without proof that the hooks run: it may deliver, so the entry stays
    // and the no-turn resend path, bounded by MAX_ATTEMPTS, decides what happens next.
    if (track || result.kind === 'uncertain') {
      flight = { key: head.key, sentAt: result.sentAt, attempts }
      return false
    }
    return removeAfterDelivery(head)
  }

  async function pass(tick: boolean): Promise<void> {
    for (;;) {
      if (closed) return
      if (opts.isOwner && !opts.isOwner()) return
      let entries: QueueEntry[] | null
      try {
        entries = loadEntries(path, corruptPath, log)
      } catch (err) {
        log(`cannot read the notification queue: ${err}`)
        return
      }
      // A read failure says nothing about the queue. Keep the in-flight and pending-removal state, so a recovered
      // read finds the delivered head still accounted for and doesn't send it again.
      if (entries === null) return
      const head = entries[0]
      if (!head) {
        flight = null
        removeOnly = null
        timedOut = null
        return
      }
      if (removeOnly !== null && removeOnly !== head.key) removeOnly = null
      // A delivered head whose removal failed is removed again, before any send, whether or not delivery is gated.
      if (removeOnly === head.key) {
        if (!removeHead(head)) return
        removeOnly = null
        continue
      }
      if (tick && now() < blockedUntil) return
      const ungated = !opts.readState || opts.disabled?.() === true
      let next: boolean
      if (ungated) {
        next = await passUngated(head)
      } else {
        let state: SessionState | null = null
        try { state = opts.readState!() } catch (err) { log(`cannot read the session state: ${err}`) }
        if (state) sawState = true
        next = await passGated(head, state)
      }
      if (!next) return
    }
  }

  /** Starts the loop unless it runs. Returns its promise only to the caller that started it. */
  function run(tick: boolean): Promise<void> | null {
    if (!isOpen || closed) return null
    if (current) {
      // The running loop re-reads the file before each decision, so it picks up
      // an appended line. If it stops on a failure first, `again` runs one more
      // pass, so a request made during the failing pass isn't lost.
      if (!tick) again = true
      return null
    }
    const started = (async () => {
      try {
        do {
          again = false
          await pass(tick)
        } while (again)
      } catch (err) {
        log(`pump failed: ${err}`)
      } finally {
        current = null
      }
    })()
    current = started
    return started
  }

  /** Runs the loop and waits for it, including the pass that a concurrent request asked for. */
  const pump = async (): Promise<void> => {
    const started = run(false)
    if (started) await started
    else if (current) await current
  }

  return {
    async enqueue(n) {
      let key: string
      try {
        key = appendEntry(path, n, now(), log)
      } catch (err) {
        log(`failed to queue notification, sending directly: ${err}`)
        try {
          await send(n)
        } catch (sendErr) {
          log(`direct send failed, notification lost: ${sendErr}`)
        }
        return 'sent'
      }
      remember(ownKeys, key)
      appendedKey = key
      const started = run(false)
      if (!started) appendedKey = null
      else {
        try { await started } finally { appendedKey = null }
      }
      return sentKeys.has(key) ? 'sent' : 'held'
    },
    pump,
    flush: pump,
    open() {
      if (isOpen) return
      isOpen = true
      sweepStaleTemp(path, log)
      if (opts.pollMs && opts.pollMs > 0) {
        timer = setInterval(() => { void run(true) }, opts.pollMs)
        timer.unref?.()
      }
      void run(false)
    },
    close() {
      closed = true
      if (timer) clearInterval(timer)
      timer = undefined
    },
    stats() {
      let depth = 0
      try { depth = readEntries(path, corruptPath, () => {}).length } catch {}
      return { depth, inFlight: flight !== null }
    },
  }
}
