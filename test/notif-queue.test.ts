import { afterEach, describe, expect, test } from 'bun:test'
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  appendEntry, BOOT_GRACE_MS, createQueue, readEntries, removeEntry, type Notification,
} from '../notif-queue.ts'

// Every test works in a temporary directory with a stub `send`. Nothing here
// touches the live state directory or the live bot.

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'notif-queue-test-'))
  dirs.push(dir)
  return {
    dir,
    path: join(dir, 'pending_notifications.jsonl'),
    corruptPath: join(dir, 'pending_notifications.corrupt.jsonl'),
  }
}

function note(content: string): Notification {
  return { method: 'notifications/claude/channel', params: { content, meta: { chat_id: '1' } } }
}

function content(n: Notification): string {
  return (n.params as { content: string }).content
}

function legacyLine(text: string): string {
  return JSON.stringify({ ...note(text), _queuedAt: '2026-01-01T00:00:00.000Z' })
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition')
    await new Promise(r => setTimeout(r, 5))
  }
}

/** Opens the queue and lets its first flush on the empty file finish, so the test controls the next flush. */
async function openIdle(q: { open(): void }): Promise<void> {
  q.open()
  await new Promise(r => setTimeout(r, 15))
}

function queued(path: string, corruptPath: string): string[] {
  return readEntries(path, corruptPath, () => {}).map(e => content(e.notification))
}

describe('append during send', () => {
  test('keeps a line appended while a send is pending', async () => {
    const { path, corruptPath } = setup()
    const sent: string[] = []
    let injected = false
    const q = createQueue({
      path,
      corruptPath,
      log: () => {},
      send: async n => {
        sent.push(content(n))
        if (!injected) {
          injected = true
          // A message arrives while the send of "A" is still pending.
          appendEntry(path, note('B'))
          return
        }
        throw new Error('MCP unreachable')
      },
    })
    await openIdle(q)
    await q.enqueue(note('A'))
    // "A" went out and "B" was appended during that send. Removing "A" must
    // not rewrite the file from the snapshot taken before the append.
    expect(sent).toEqual(['A', 'B'])
    expect(queued(path, corruptPath)).toEqual(['B'])
  })
})

describe('corrupt lines', () => {
  test('quarantines an unparsable line and delivers the next entry', async () => {
    const { path, corruptPath } = setup()
    writeFileSync(path, 'not json\n')
    appendEntry(path, note('after'))
    const sent: string[] = []
    const q = createQueue({ path, corruptPath, log: () => {}, send: async n => { sent.push(content(n)) } })
    q.open()
    await waitFor(() => sent.length === 1)
    expect(sent).toEqual(['after'])
    expect(readFileSync(corruptPath, 'utf8')).toBe('not json\n')
    expect(existsSync(path)).toBe(false)
  })

  test('quarantines valid JSON that is not a notification', async () => {
    const { path, corruptPath } = setup()
    const bad = [
      '[]',
      '"text"',
      'null',
      '{"method":5}',
      '{"method":"tools/call","params":{}}',
      '{"method":"notifications/claude/channel","params":"text"}',
      '{"method":"notifications/claude/channel","params":[1]}',
    ]
    writeFileSync(path, bad.join('\n') + '\n')
    appendEntry(path, note('good'))
    const sent: string[] = []
    const q = createQueue({ path, corruptPath, log: () => {}, send: async n => { sent.push(content(n)) } })
    q.open()
    await waitFor(() => sent.length === 1)
    expect(sent).toEqual(['good'])
    expect(readFileSync(corruptPath, 'utf8').split('\n').filter(Boolean)).toEqual(bad)
  })

  test('keeps delivering when the quarantine file cannot be written', async () => {
    const { path, corruptPath } = setup()
    mkdirSync(corruptPath) // a directory makes the append fail with EISDIR
    writeFileSync(path, 'not json\n')
    appendEntry(path, note('after'))
    const sent: string[] = []
    const logs: string[] = []
    const q = createQueue({ path, corruptPath, log: m => logs.push(m), send: async n => { sent.push(content(n)) } })
    q.open()
    await waitFor(() => sent.length === 1)
    expect(sent).toEqual(['after'])
    // The bad line stays in place for a later attempt.
    expect(readFileSync(path, 'utf8')).toContain('not json')
    expect(logs.some(m => m.includes('could not quarantine'))).toBe(true)
  })

  test('does not append a quarantined line twice when its removal failed', () => {
    const { path, corruptPath } = setup()
    writeFileSync(path, 'junk line\n')
    appendEntry(path, note('keep'))
    // A directory at the temp path makes every rewrite fail.
    mkdirSync(`${path}.tmp-${process.pid}`)
    readEntries(path, corruptPath, () => {})
    readEntries(path, corruptPath, () => {})
    expect(readFileSync(corruptPath, 'utf8')).toBe('junk line\n')
    rmSync(`${path}.tmp-${process.pid}`, { recursive: true })
    readEntries(path, corruptPath, () => {})
    expect(readFileSync(corruptPath, 'utf8')).toBe('junk line\n')
    expect(readFileSync(path, 'utf8')).not.toContain('junk line')
  })

  test('does not log the content of a quarantined line', () => {
    const { path, corruptPath } = setup()
    writeFileSync(path, 'TOPSECRET-12345 {broken\n')
    const logs: string[] = []
    readEntries(path, corruptPath, m => logs.push(m))
    expect(logs.length).toBeGreaterThan(0)
    for (const m of logs) expect(m).not.toContain('TOPSECRET')
    // A quarantine failure logs no content either.
    const second = setup()
    mkdirSync(second.corruptPath)
    writeFileSync(second.path, 'TOPSECRET-67890 {broken\n')
    const logs2: string[] = []
    readEntries(second.path, second.corruptPath, m => logs2.push(m))
    expect(logs2.length).toBeGreaterThan(0)
    for (const m of logs2) expect(m).not.toContain('TOPSECRET')
  })

  test('a torn last line does not corrupt the next append', () => {
    const { path, corruptPath } = setup()
    appendEntry(path, note('first'))
    // A failed write left half a line with no newline.
    appendFileSync(path, '{"method":"notifications/claude/channel","params":{"content":"to')
    appendEntry(path, note('second'))
    expect(queued(path, corruptPath)).toEqual(['first', 'second'])
    expect(readFileSync(corruptPath, 'utf8')).toContain('"content":"to')
  })
})

describe('ordering and delivery', () => {
  test('keeps FIFO order across appends, sends, and reload', async () => {
    const { path, corruptPath } = setup()
    const sent: string[] = []
    let failFirst = true
    const send = async (n: Notification) => {
      if (failFirst) {
        failFirst = false
        throw new Error('MCP unreachable')
      }
      sent.push(content(n))
    }
    const first = createQueue({ path, corruptPath, log: () => {}, send })
    await openIdle(first)
    await first.enqueue(note('A')) // send rejects, "A" stays
    await first.enqueue(note('B')) // delivers "A" then "B"
    expect(sent).toEqual(['A', 'B'])
    appendEntry(path, note('C'))
    appendEntry(path, note('D'))
    // A new process reads the same file and keeps the order.
    const second = createQueue({ path, corruptPath, log: () => {}, send })
    second.open()
    await waitFor(() => sent.length === 4)
    expect(sent).toEqual(['A', 'B', 'C', 'D'])
  })

  test('sends directly when the queue file cannot be written', async () => {
    const { path, corruptPath } = setup()
    mkdirSync(path) // a directory makes the append fail with EISDIR
    const sent: string[] = []
    const logs: string[] = []
    const q = createQueue({ path, corruptPath, log: m => logs.push(m), send: async n => { sent.push(content(n)) } })
    await openIdle(q)
    await q.enqueue(note('direct'))
    expect(sent).toEqual(['direct'])
    expect(logs.some(m => m.includes('sending directly'))).toBe(true)
  })

  test('enqueue never rejects when the direct send also fails', async () => {
    const { path, corruptPath } = setup()
    mkdirSync(path)
    const logs: string[] = []
    const q = createQueue({ path, corruptPath, log: m => logs.push(m), send: async () => { throw new Error('down') } })
    await openIdle(q)
    await q.enqueue(note('lost'))
    expect(logs.some(m => m.includes('notification lost'))).toBe(true)
  })

  test('delivers a line without _id written by an older version', async () => {
    const { path, corruptPath } = setup()
    writeFileSync(path, legacyLine('legacy') + '\n')
    const sent: Notification[] = []
    const q = createQueue({ path, corruptPath, log: () => {}, send: async n => { sent.push(n) } })
    q.open()
    await waitFor(() => sent.length === 1)
    expect(content(sent[0])).toBe('legacy')
    expect(existsSync(path)).toBe(false)
  })

  test('removes one of two identical lines without _id', () => {
    const { path, corruptPath } = setup()
    const line = legacyLine('same')
    writeFileSync(path, `${line}\n${line}\n`)
    const entries = readEntries(path, corruptPath, () => {})
    expect(entries).toHaveLength(2)
    expect(entries[0].key).toBe(line)
    removeEntry(path, entries[0].key)
    expect(readEntries(path, corruptPath, () => {})).toHaveLength(1)
  })

  test('strips _id and _queuedAt before sending', async () => {
    const { path, corruptPath } = setup()
    appendEntry(path, note('plain'))
    const sent: Notification[] = []
    const q = createQueue({ path, corruptPath, log: () => {}, send: async n => { sent.push(n) } })
    q.open()
    await waitFor(() => sent.length === 1)
    expect(Object.keys(sent[0]).sort()).toEqual(['method', 'params'])
    expect(sent[0]).toEqual(note('plain'))
  })

  test('gives each appended entry a unique _id', () => {
    const { path, corruptPath } = setup()
    const a = appendEntry(path, note('a'))
    const b = appendEntry(path, note('b'))
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThan(0)
    const keys = readEntries(path, corruptPath, () => {}).map(e => e.key)
    expect(keys).toEqual([a, b])
  })

  test('delivers a message queued before a restart after open', async () => {
    const { path, corruptPath } = setup()
    const before = createQueue({ path, corruptPath, log: () => {}, send: async () => { throw new Error('unused') } })
    await before.enqueue(note('queued before restart')) // never opened, so it only reaches the file
    const sent: string[] = []
    const after = createQueue({ path, corruptPath, log: () => {}, send: async n => { sent.push(content(n)) } })
    expect(sent).toEqual([])
    after.open()
    await waitFor(() => sent.length === 1)
    expect(sent).toEqual(['queued before restart'])
    expect(existsSync(path)).toBe(false)
  })

  test('sends nothing before open and drains in order after it', async () => {
    const { path, corruptPath } = setup()
    const sent: string[] = []
    const q = createQueue({ path, corruptPath, log: () => {}, send: async n => { sent.push(content(n)) } })
    await q.enqueue(note('one'))
    await q.enqueue(note('two'))
    await q.flush()
    expect(sent).toEqual([])
    expect(queued(path, corruptPath)).toEqual(['one', 'two'])
    q.open()
    await waitFor(() => sent.length === 2)
    expect(sent).toEqual(['one', 'two'])
    expect(BOOT_GRACE_MS).toBe(10_000)
  })

  test('keeps the entry and retries when send rejects', async () => {
    const { path, corruptPath } = setup()
    let up = false
    const sent: string[] = []
    const q = createQueue({
      path,
      corruptPath,
      log: () => {},
      send: async n => {
        if (!up) throw new Error('MCP unreachable')
        sent.push(content(n))
      },
    })
    await openIdle(q)
    await q.enqueue(note('wait'))
    expect(sent).toEqual([])
    expect(queued(path, corruptPath)).toEqual(['wait'])
    up = true
    await q.flush()
    expect(sent).toEqual(['wait'])
    expect(existsSync(path)).toBe(false)
  })

  test('stops the flush when removal fails and resends on the next flush', async () => {
    const { path, corruptPath } = setup()
    appendEntry(path, note('A'))
    appendEntry(path, note('B'))
    const tmp = `${path}.tmp-${process.pid}`
    mkdirSync(tmp) // a directory makes the rewrite fail with EISDIR
    const sent: string[] = []
    const logs: string[] = []
    const q = createQueue({ path, corruptPath, log: m => logs.push(m), send: async n => { sent.push(content(n)) } })
    q.open()
    await waitFor(() => logs.some(m => m.includes('sent again')))
    await new Promise(r => setTimeout(r, 50))
    // One send, no loop within the flush.
    expect(sent).toEqual(['A'])
    expect(logs.some(m => m.includes('sent again'))).toBe(true)
    rmSync(tmp, { recursive: true })
    await q.flush()
    // "A" is a duplicate, the approved cost of never losing a message.
    expect(sent).toEqual(['A', 'A', 'B'])
    expect(existsSync(path)).toBe(false)
  })

  test('runs one flush at a time and delivers entries appended during it', async () => {
    const { path, corruptPath } = setup()
    let inFlight = 0
    let maxInFlight = 0
    const sent: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>(r => { release = r })
    const q = createQueue({
      path,
      corruptPath,
      log: () => {},
      send: async n => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        if (sent.length === 0) await gate
        sent.push(content(n))
        inFlight--
      },
    })
    await openIdle(q)
    const first = q.enqueue(note('A'))
    await waitFor(() => inFlight === 1)
    await q.enqueue(note('B')) // returns at once, because a flush is running
    await q.flush()
    expect(inFlight).toBe(1)
    release()
    await first
    await waitFor(() => sent.length === 2)
    expect(sent).toEqual(['A', 'B'])
    expect(maxInFlight).toBe(1)
  })

  test('retries once when an enqueue arrives during a flush that then fails', async () => {
    const { path, corruptPath } = setup()
    const sent: string[] = []
    let attempts = 0
    let q!: ReturnType<typeof createQueue>
    q = createQueue({
      path,
      corruptPath,
      log: () => {},
      send: async n => {
        attempts++
        if (attempts === 1) {
          void q.enqueue(note('B')) // arrives while the flush for "A" runs
          throw new Error('MCP unreachable')
        }
        sent.push(content(n))
      },
    })
    await openIdle(q)
    await q.enqueue(note('A'))
    await waitFor(() => sent.length === 2)
    expect(sent).toEqual(['A', 'B'])
  })

  test('does not retry in a loop when the send keeps failing', async () => {
    const { path, corruptPath } = setup()
    let attempts = 0
    const q = createQueue({ path, corruptPath, log: () => {}, send: async () => { attempts++; throw new Error('down') } })
    await openIdle(q)
    await q.enqueue(note('A'))
    await new Promise(r => setTimeout(r, 50))
    expect(attempts).toBe(1)
  })
})

describe('files', () => {
  test('deletes the queue file when the last entry is removed', () => {
    const { path } = setup()
    const id = appendEntry(path, note('only'))
    expect(existsSync(path)).toBe(true)
    removeEntry(path, id)
    expect(existsSync(path)).toBe(false)
  })

  test('removeEntry is a no-op when the file or key is absent', () => {
    const { path } = setup()
    removeEntry(path, 'nope')
    appendEntry(path, note('x'))
    removeEntry(path, 'nope')
    expect(existsSync(path)).toBe(true)
  })

  test('creates the queue and quarantine files with mode 0600', () => {
    const { dir, corruptPath } = setup()
    const path = join(dir, 'nested', 'pending_notifications.jsonl')
    appendEntry(path, note('x'))
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(0o700)
    appendFileSync(path, 'junk\n')
    readEntries(path, corruptPath, () => {})
    expect(statSync(corruptPath).mode & 0o777).toBe(0o600)
    // A rewrite keeps the mode.
    const id = appendEntry(path, note('y'))
    removeEntry(path, id)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test('removes a stale temp file at open and leaves one whose process is alive', () => {
    const { path, corruptPath } = setup()
    const stale = `${path}.tmp-4000000`
    const alive = `${path}.tmp-${process.ppid}`
    writeFileSync(stale, 'private message\n')
    writeFileSync(alive, 'other process\n')
    const q = createQueue({ path, corruptPath, log: () => {}, send: async () => {} })
    q.open()
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(alive)).toBe(true)
  })
})

describe('server.ts wiring', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'server.ts'), 'utf8')

  test('server.ts defines NOTIF_CORRUPT and log, and opens the queue after BOOT_GRACE_MS', () => {
    expect(src).toMatch(/import \{[^}]*\bBOOT_GRACE_MS\b[^}]*\} from '\.\/notif-queue\.ts'/)
    expect(src).toMatch(/import \{[^}]*\bcreateQueue\b[^}]*\} from '\.\/notif-queue\.ts'/)
    expect(src).toMatch(/const NOTIF_CORRUPT = join\(STATE_DIR, 'pending_notifications\.corrupt\.jsonl'\)/)
    expect(src).toMatch(/const log = \(message: string\)/)
    expect(src).toMatch(/createQueue\(\{[^}]*corruptPath: NOTIF_CORRUPT[^}]*log[^}]*\}\)/)
    expect(src).toMatch(/setTimeout\(\(\) => queue\.open\(\), BOOT_GRACE_MS\)/)
    expect(src).not.toContain('flushQueue')
    expect(src).toMatch(/await queue\.enqueue\(entry\)/)
  })

  test('permission notifications never pass through the queue', () => {
    const permission = [...src.matchAll(/'notifications\/claude\/channel\/permission'/g)]
    expect(permission.length).toBeGreaterThanOrEqual(2)
    for (const m of permission) {
      const before = src.slice(Math.max(0, m.index! - 80), m.index!)
      expect(before).toMatch(/mcp\.notification\(\{\s*method: $/)
    }
    const queued = [...src.matchAll(/notifyOrQueue\(\{\s*method: '([^']+)'/g)]
    expect(queued.length).toBeGreaterThanOrEqual(3)
    for (const m of queued) expect(m[1]).toBe('notifications/claude/channel')
  })
})
