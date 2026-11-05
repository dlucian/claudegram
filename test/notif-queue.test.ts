import { afterEach, describe, expect, test } from 'bun:test'
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ACK_TIMEOUT_MS, appendEntry, BOOT_GRACE_MS, createQueue, FAIL_OPEN_SPACING_MS, LOCK_STALE_MS, LOCK_WAIT_MS,
  MAX_ATTEMPTS, MAX_HOLD_MS, withQueueLock,
  QUEUED_REACTION, readEntries, readSessionState, removeEntry, SEND_RETRY_MS, setAttempts, SETTLE_MS, STALE_BUSY_MS,
  sweepDeadStateFiles, type Notification, type SessionState,
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
    await waitFor(() => !existsSync(path))
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
    await waitFor(() => !existsSync(path))
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

  test('strips _id, _queuedAt, and _attempts before sending', async () => {
    const { path, corruptPath } = setup()
    setAttempts(path, appendEntry(path, note('plain')), 2)
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
    await waitFor(() => !existsSync(path))
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

  test('stops the flush when removal fails and retries only the removal on the next flush', async () => {
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
    // "A" was delivered, so only its removal is retried and it is never sent twice.
    expect(sent).toEqual(['A', 'B'])
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
    void q.flush()
    await new Promise(r => setTimeout(r, 10))
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
    expect(src).toMatch(/createQueue\(\{\s*path: NOTIF_QUEUE,\s*corruptPath: NOTIF_CORRUPT,[\s\S]*?\n  log,/)
    expect(src).toMatch(/setTimeout\(\(\) => queue\.open\(\), BOOT_GRACE_MS\)/)
    expect(src).not.toContain('flushQueue')
    expect(src).toMatch(/return queue\.enqueue\(entry\)/)
  })

  test('server.ts wires the session gate to the owner PID, bot.pid, and the kill switch', () => {
    expect(src).toMatch(/ownerPid = pid\n\s*break/) // the nearest claude ancestor
    expect(src).toMatch(/readState: \(\) => readSessionState\(STATE_DIR, ownerPid\)/)
    expect(src).toMatch(/const QUEUE_DISABLED = join\(STATE_DIR, 'queue-disabled'\)/)
    expect(src).toMatch(/disabled: \(\) => existsSync\(QUEUE_DISABLED\)/)
    expect(src).toMatch(/isOwner: ownsBot/)
    expect(src).toMatch(/code === 'ESRCH'/) // a dead bot.pid owner does not hold the queue
    expect(src).toMatch(/pollMs: POLL_MS/)
    expect(src).toMatch(/sweepDeadStateFiles\(STATE_DIR, log\)/)
    expect(src).toMatch(/try \{ queue\.close\(\) \}/)
  })

  test('a held text message gets the queued reaction, and an ask tap gets a Queued toast', () => {
    expect(src).toMatch(/if \(status === 'held' && msgId != null\) void markQueued\(chat_id, msgId\)/)
    expect(src).toMatch(/askStatus === 'held' \? 'Queued' : 'Sent'/)
    // Reactions are queued in order and never get a reaction of their own.
    const reaction = src.slice(src.indexOf("bot.on('message_reaction'"))
    expect(reaction.slice(0, 3500)).not.toContain('markQueued')
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

// ---------------------------------------------------------------------------
// Gated delivery (dlucian/ezri#474). The clock, the session state, and the
// bot.pid check are all fakes, so each test decides what the session is doing.

function gatedSetup(overrides: Partial<Parameters<typeof createQueue>[0]> = {}) {
  const paths = setup()
  const clock = { t: Date.now() }
  const world = { state: null as SessionState | null, owner: true, disabled: false }
  const sent: string[] = []
  const warns: string[] = []
  const released: string[] = []
  const logs: string[] = []
  const q = createQueue({
    path: paths.path,
    corruptPath: paths.corruptPath,
    log: m => logs.push(m),
    send: async n => { sent.push(content(n)) },
    readState: () => world.state,
    isOwner: () => world.owner,
    disabled: () => world.disabled,
    warn: async (_e, text) => { warns.push(text) },
    onRelease: async n => { released.push(content(n)) },
    now: () => clock.t,
    ...overrides,
  })
  /** Writes the session state as a hook would, stamped with the fake clock plus `ago` milliseconds in the past. */
  const write = (state: 'busy' | 'idle', ago = 0) => { world.state = { state, mtimeMs: clock.t - ago } }
  const advance = (ms: number) => { clock.t += ms }
  /** Opens the queue and lets the first pass on the empty file finish, so the test controls the next one. */
  const open = async () => { q.open(); await new Promise(r => setTimeout(r, 10)) }
  return { ...paths, clock, world, sent, warns, released, logs, q, write, advance, open }
}

describe('hold until idle', () => {
  test('holds while the state is busy and fresh', async () => {
    const g = gatedSetup()
    await g.open()
    g.write('busy')
    expect(await g.q.enqueue(note('A'))).toBe('held')
    for (let i = 0; i < 5; i++) {
      g.advance(60_000)
      g.write('busy') // the session keeps working and the hooks keep writing
      await g.q.pump()
    }
    expect(g.sent).toEqual([])
    expect(queued(g.path, g.corruptPath)).toEqual(['A'])
  })

  test('sends at once when idle past the settle window', async () => {
    const g = gatedSetup()
    await g.open()
    g.write('idle', SETTLE_MS)
    expect(await g.q.enqueue(note('A'))).toBe('sent')
    expect(g.sent).toEqual(['A'])
  })

  test('holds during the settle window and stays held if busy returns', async () => {
    const g = gatedSetup()
    await g.open()
    g.write('idle', SETTLE_MS - 1)
    expect(await g.q.enqueue(note('A'))).toBe('held')
    g.advance(500)
    g.write('busy') // a background task notification starts a turn inside the window
    g.advance(SETTLE_MS * 2)
    await g.q.pump()
    expect(g.sent).toEqual([])
    g.write('idle')
    g.advance(SETTLE_MS)
    await g.q.pump()
    expect(g.sent).toEqual(['A'])
  })

  test('releases exactly one entry per idle transition', async () => {
    const g = gatedSetup()
    await g.open()
    g.write('idle', SETTLE_MS)
    for (const c of ['A', 'B', 'C']) await g.q.enqueue(note(c))
    expect(g.sent).toEqual(['A'])
    // Nothing changes: the session has not reacted yet, so nothing else goes out.
    g.advance(10_000)
    g.write('idle', 10_000 + SETTLE_MS) // an older idle write, not later than the send
    await g.q.pump()
    expect(g.sent).toEqual(['A'])
    // Turn for A: busy, then idle.
    g.advance(1_000)
    g.write('busy')
    await g.q.pump()
    g.advance(20_000)
    g.write('idle')
    await g.q.pump()
    expect(g.sent).toEqual(['A']) // A is removed, and B waits out the settle window
    expect(queued(g.path, g.corruptPath)).toEqual(['B', 'C'])
    g.advance(SETTLE_MS)
    await g.q.pump()
    expect(g.sent).toEqual(['A', 'B'])
    await g.q.pump()
    expect(g.sent).toEqual(['A', 'B'])
  })

  test('queues a second message sent before the first turn starts', async () => {
    const g = gatedSetup()
    await g.open()
    g.write('idle', SETTLE_MS)
    expect(await g.q.enqueue(note('A'))).toBe('sent')
    g.advance(200) // the hook has not run yet, so the state still says idle
    expect(await g.q.enqueue(note('B'))).toBe('held')
    expect(g.sent).toEqual(['A'])
    expect(queued(g.path, g.corruptPath)).toEqual(['A', 'B'])
  })

  test('keeps FIFO order across holds, releases, and reload', async () => {
    const g = gatedSetup()
    await g.open()
    g.write('busy')
    for (const c of ['A', 'B']) await g.q.enqueue(note(c))
    g.q.close()
    // A new process opens the same file, and the session has gone idle.
    const again = createQueue({
      path: g.path, corruptPath: g.corruptPath, log: () => {}, send: async n => { g.sent.push(content(n)) },
      readState: () => g.world.state, now: () => g.clock.t,
    })
    again.open()
    await again.enqueue(note('C'))
    g.advance(1_000)
    g.write('idle', SETTLE_MS)
    await again.pump()
    expect(g.sent).toEqual(['A'])
    for (const expected of ['B', 'C']) {
      g.advance(1_000)
      g.write('busy')
      g.advance(5_000)
      g.write('idle')
      await again.pump() // removes the turn that just ended
      g.advance(SETTLE_MS)
      await again.pump()
      expect(g.sent.at(-1)).toBe(expected)
    }
    expect(g.sent).toEqual(['A', 'B', 'C'])
  })
})

describe('staleness and the hold cap', () => {
  test('treats busy as stale at STALE_BUSY_MS and fresh 1 ms before', async () => {
    const g = gatedSetup()
    await g.open()
    g.write('busy', STALE_BUSY_MS - 1)
    await g.q.enqueue(note('A'))
    expect(g.sent).toEqual([])
    g.advance(1)
    await g.q.pump()
    expect(g.sent).toEqual(['A'])
  })

  test('drains one entry per spacing interval while stale', async () => {
    const g = gatedSetup()
    await g.open()
    g.write('busy', STALE_BUSY_MS + 1)
    for (const c of ['A', 'B', 'C']) await g.q.enqueue(note(c))
    expect(g.sent).toEqual(['A'])
    g.advance(FAIL_OPEN_SPACING_MS - 1)
    await g.q.pump()
    expect(g.sent).toEqual(['A'])
    g.advance(1)
    await g.q.pump()
    expect(g.sent).toEqual(['A', 'B'])
    g.advance(FAIL_OPEN_SPACING_MS)
    await g.q.pump()
    expect(g.sent).toEqual(['A', 'B', 'C'])
    expect(existsSync(g.path)).toBe(false) // a fail-open send is removed at send
  })

  test('releases a head older than MAX_HOLD_MS under a fresh marker', async () => {
    const g = gatedSetup()
    await g.open()
    g.write('busy')
    await g.q.enqueue(note('A'))
    g.advance(MAX_HOLD_MS - 1000)
    g.write('busy') // a runaway turn keeps the marker fresh
    await g.q.pump()
    expect(g.sent).toEqual([])
    g.advance(1000)
    g.write('busy')
    await g.q.pump()
    expect(g.sent).toEqual(['A'])
    expect(existsSync(g.path)).toBe(false)
  })

  test('counts a head with no queuedAt as past the hold cap', async () => {
    const g = gatedSetup()
    writeFileSync(g.path, JSON.stringify({ ...note('old'), _id: 'x1' }) + '\n')
    g.write('busy')
    await g.open()
    expect(g.sent).toEqual(['old'])
  })
})

describe('missing and foreign state', () => {
  test('delivers immediately when the state file is missing or unreadable', async () => {
    const g = gatedSetup()
    await g.open()
    g.world.state = null
    expect(await g.q.enqueue(note('A'))).toBe('sent')
    expect(g.sent).toEqual(['A'])
    const dir = mkdtempSync(join(tmpdir(), 'state-read-'))
    dirs.push(dir)
    expect(readSessionState(dir, 4242)).toBeNull() // missing
    mkdirSync(join(dir, 'session-state'))
    writeFileSync(join(dir, 'session-state', '4242'), 'running\n')
    expect(readSessionState(dir, 4242)).toBeNull() // not a state word
    writeFileSync(join(dir, 'session-state', '4242'), '')
    expect(readSessionState(dir, 4242)).toBeNull()
    expect(readSessionState(dir, null)).toBeNull() // no claude ancestor
  })

  test('ignores a busy file that belongs to another PID', () => {
    const dir = mkdtempSync(join(tmpdir(), 'state-read-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'session-state'))
    writeFileSync(join(dir, 'session-state', '111'), 'busy\n')
    expect(readSessionState(dir, 111)?.state).toBe('busy')
    expect(readSessionState(dir, 222)).toBeNull()
  })

  test("removes dead PIDs' state files and keeps live ones", () => {
    const dir = mkdtempSync(join(tmpdir(), 'state-sweep-'))
    dirs.push(dir)
    const sd = join(dir, 'session-state')
    mkdirSync(sd)
    for (const name of ['101', '102']) writeFileSync(join(sd, name), 'idle\n')
    writeFileSync(join(sd, '.101.55.tmp'), 'busy\n')
    writeFileSync(join(sd, 'notes.txt'), 'keep')
    const removed = sweepDeadStateFiles(dir, () => {}, pid => pid === 102, Date.now() + 120_000)
    expect(removed).toBe(2) // dead 101 and the old temp file
    expect(existsSync(join(sd, '101'))).toBe(false)
    expect(existsSync(join(sd, '102'))).toBe(true)
    expect(existsSync(join(sd, '.101.55.tmp'))).toBe(false)
    expect(existsSync(join(sd, 'notes.txt'))).toBe(true)
  })
})

describe('in flight', () => {
  test('keeps a sent head until an idle write later than the send', async () => {
    const g = gatedSetup()
    await g.open()
    g.write('idle', SETTLE_MS)
    await g.q.enqueue(note('A'))
    const sentAt = g.clock.t
    expect(queued(g.path, g.corruptPath)).toEqual(['A'])
    g.world.state = { state: 'idle', mtimeMs: sentAt } // not later than the send
    g.advance(5_000)
    await g.q.pump()
    expect(queued(g.path, g.corruptPath)).toEqual(['A'])
    g.world.state = { state: 'idle', mtimeMs: sentAt + 1 }
    await g.q.pump()
    expect(existsSync(g.path)).toBe(false)
  })

  test('a send that resolves with no turn following must not lose the entry', async () => {
    // The harness can drop a notification that arrives before it registers its
    // channel handler, even though `mcp.notification` resolves.
    const g = gatedSetup()
    await g.open()
    g.write('idle', SETTLE_MS)
    await g.q.enqueue(note('A'))
    expect(g.sent).toEqual(['A'])
    for (let i = 0; i < 20; i++) {
      g.advance(1_000)
      await g.q.pump() // the state never changes: no turn started
    }
    expect(queued(g.path, g.corruptPath)).toEqual(['A'])
    expect(g.sent).toEqual(['A']) // still inside the ack window
    g.advance(ACK_TIMEOUT_MS)
    await g.q.pump()
    expect(g.sent).toEqual(['A', 'A']) // the second send reaches a registered handler
    g.advance(1_000)
    g.write('busy')
    g.advance(2_000)
    g.write('idle')
    await g.q.pump()
    expect(existsSync(g.path)).toBe(false)
  })

  test('resends after ACK_TIMEOUT_MS and warns after MAX_ATTEMPTS', async () => {
    const g = gatedSetup()
    await g.open()
    g.write('idle', SETTLE_MS)
    await g.q.enqueue(note('B'))
    await g.q.enqueue(note('after'))
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      g.advance(ACK_TIMEOUT_MS - 1)
      await g.q.pump()
      expect(g.sent.length).toBe(i) // not yet
      g.advance(1)
      await g.q.pump()
      expect(g.sent.length).toBe(i + 1)
    }
    expect(g.sent).toEqual(Array(MAX_ATTEMPTS).fill('B'))
    expect(g.warns).toEqual([])
    g.advance(ACK_TIMEOUT_MS)
    await g.q.pump()
    expect(g.warns).toHaveLength(1)
    expect(g.warns[0]).toContain('entry') // no message_id in this fixture, so it names the entry
    expect(queued(g.path, g.corruptPath)).toEqual(['after']) // the queue moved on
    g.advance(SETTLE_MS)
    await g.q.pump()
    expect(g.sent.at(-1)).toBe('after')
  })

  test('names the message ID in the dropped-message warning', async () => {
    const g = gatedSetup()
    await g.open()
    g.write('idle', SETTLE_MS)
    await g.q.enqueue({ method: 'notifications/claude/channel', params: { content: 'X', meta: { message_id: '777' } } })
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      g.advance(ACK_TIMEOUT_MS)
      await g.q.pump()
    }
    expect(g.warns[0]).toContain('message 777')
    expect(g.warns[0]).not.toContain('X')
  })

  test('a failed warning does not block the head', async () => {
    const g = gatedSetup({ warn: async () => { throw new Error('telegram down') } })
    await g.open()
    g.write('idle', SETTLE_MS)
    await g.q.enqueue(note('A'))
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      g.advance(ACK_TIMEOUT_MS)
      await g.q.pump()
    }
    expect(existsSync(g.path)).toBe(false)
    expect(g.logs.some(m => m.includes('cannot send the dropped-message warning'))).toBe(true)
  })

  test('removes a head whose busy marker went stale', async () => {
    const g = gatedSetup()
    await g.open()
    g.write('idle', SETTLE_MS)
    await g.q.enqueue(note('A'))
    g.advance(1_000)
    g.write('busy') // the turn started, and then the hooks went quiet
    g.advance(STALE_BUSY_MS)
    await g.q.pump()
    expect(existsSync(g.path)).toBe(false)
  })

  test('removes a head that stayed in flight for MAX_HOLD_MS', async () => {
    const g = gatedSetup()
    await g.open()
    g.write('idle', SETTLE_MS)
    await g.q.enqueue(note('A'))
    g.advance(MAX_HOLD_MS - 1)
    g.write('busy')
    await g.q.pump()
    expect(queued(g.path, g.corruptPath)).toEqual(['A'])
    g.advance(1)
    g.write('busy')
    await g.q.pump()
    expect(existsSync(g.path)).toBe(false)
  })

  test('never resends a fresh message when no state file exists', async () => {
    const g = gatedSetup()
    await g.open()
    g.world.state = null
    await g.q.enqueue(note('A'))
    for (let i = 0; i < 5; i++) {
      g.advance(ACK_TIMEOUT_MS)
      await g.q.pump()
    }
    expect(g.sent).toEqual(['A'])
    expect(existsSync(g.path)).toBe(false)
  })

  test('replays a persisted head after restart and keeps its retries', async () => {
    const g = gatedSetup()
    // An earlier process queued "A" and sent it once before it died.
    const key = appendEntry(g.path, note('A'))
    setAttempts(g.path, key, 1)
    expect(readEntries(g.path, g.corruptPath, () => {})[0]!.attempts).toBe(1)
    await g.open() // this process has seen no state file
    await g.q.pump()
    expect(g.sent).toEqual(['A'])
    expect(readEntries(g.path, g.corruptPath, () => {})[0]!.attempts).toBe(2)
    g.advance(ACK_TIMEOUT_MS)
    await g.q.pump() // the third and last send
    expect(g.sent).toEqual(['A', 'A'])
    g.advance(ACK_TIMEOUT_MS)
    await g.q.pump()
    expect(g.warns).toHaveLength(1)
    expect(existsSync(g.path)).toBe(false)
  })

  test('drops a persisted entry that already used its attempts without sending it again', async () => {
    const g = gatedSetup()
    const key = appendEntry(g.path, note('A'))
    setAttempts(g.path, key, MAX_ATTEMPTS)
    await g.open()
    await g.q.pump()
    expect(g.sent).toEqual([])
    expect(g.warns).toHaveLength(1)
    expect(existsSync(g.path)).toBe(false)
  })

  test('keeps the head and retries when send rejects, without using an attempt', async () => {
    let up = false
    const g = gatedSetup({ send: async () => { if (!up) throw new Error('MCP unreachable') } })
    await g.open()
    g.write('idle', SETTLE_MS)
    await g.q.enqueue(note('A'))
    for (let i = 0; i < 5; i++) {
      g.advance(SEND_RETRY_MS)
      await g.q.pump()
    }
    expect(queued(g.path, g.corruptPath)).toEqual(['A'])
    expect(readEntries(g.path, g.corruptPath, () => {})[0]!.attempts).toBeUndefined()
    up = true
    g.advance(SEND_RETRY_MS)
    await g.q.pump()
    expect(readEntries(g.path, g.corruptPath, () => {})[0]!.attempts).toBe(1)
    expect(g.warns).toEqual([])
  })

  test('a poll tick waits SEND_RETRY_MS after a rejected send', async () => {
    let calls = 0
    const g = gatedSetup({ send: async () => { calls++; throw new Error('down') }, pollMs: 5 })
    await g.open()
    g.write('idle', SETTLE_MS)
    await g.q.enqueue(note('A'))
    expect(calls).toBe(1)
    await new Promise(r => setTimeout(r, 60)) // a dozen ticks, all inside the retry wait
    expect(calls).toBe(1)
    g.advance(SEND_RETRY_MS)
    await waitFor(() => calls === 2)
    g.q.close()
  })

  test('a send that never settles is an uncertain send: the entry stays in flight and nothing overlaps it', async () => {
    const g = gatedSetup({ send: () => new Promise(() => {}), sendTimeoutMs: 20 })
    await g.open()
    g.write('idle', SETTLE_MS)
    expect(await g.q.enqueue(note('A'))).toBe('held') // the loop returned instead of hanging
    expect(g.q.stats()).toEqual({ depth: 1, inFlight: true })
    expect(g.logs.some(m => m.includes('treating the entry as in flight'))).toBe(true)
    expect(readEntries(g.path, g.corruptPath, () => {})[0]!.attempts).toBe(1) // the attempt counts
    expect(g.released).toEqual([]) // an unconfirmed send doesn't clear the queued reaction
    // Inside the ack window no second send starts, however many polls pass.
    for (let i = 0; i < 5; i++) {
      g.advance(ACK_TIMEOUT_MS / 10)
      await g.q.pump()
    }
    expect(queued(g.path, g.corruptPath)).toEqual(['A'])
  })

  test('a timed-out send without a state file stays in flight instead of being removed at send', async () => {
    const g = gatedSetup({ send: () => new Promise(() => {}), sendTimeoutMs: 20 })
    await g.open()
    g.world.state = null // no proof that the hooks run, so a resolved send would be removed at send
    expect(await g.q.enqueue(note('A'))).toBe('held')
    expect(g.q.stats()).toEqual({ depth: 1, inFlight: true })
    expect(queued(g.path, g.corruptPath)).toEqual(['A'])
  })

  test('a send that times out and then delivers is acknowledged by the later turn, not sent again', async () => {
    let finish: () => void = () => {}
    const sends: string[] = []
    const g = gatedSetup({
      send: n => new Promise<void>(r => { sends.push(content(n)); finish = r }),
      sendTimeoutMs: 20,
    })
    await g.open()
    g.write('idle', SETTLE_MS)
    await g.q.enqueue(note('A'))
    expect(g.released).toEqual([])
    finish() // the original send resolves late
    await new Promise(r => setTimeout(r, 10))
    expect(g.released).toEqual(['A']) // the marker clears once the message is known to be delivered
    g.advance(1_000)
    g.write('busy')
    g.advance(1_000)
    g.write('idle')
    await g.q.pump()
    expect(sends).toEqual(['A'])
    expect(existsSync(g.path)).toBe(false)
  })

  test('a timed-out send is resent only after the no-turn rule expires it, up to MAX_ATTEMPTS', async () => {
    const sends: string[] = []
    const g = gatedSetup({ send: n => { sends.push(content(n)); return new Promise(() => {}) }, sendTimeoutMs: 10 })
    await g.open()
    g.write('idle', SETTLE_MS)
    await g.q.enqueue(note('A'))
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      g.advance(ACK_TIMEOUT_MS - 1)
      await g.q.pump()
      expect(sends).toHaveLength(i)
      g.advance(1)
      await g.q.pump()
      expect(sends).toHaveLength(i + 1)
    }
    g.advance(ACK_TIMEOUT_MS)
    await g.q.pump()
    expect(g.warns).toHaveLength(1)
    expect(existsSync(g.path)).toBe(false)
  })

  test('without a gate, a send that is still pending is not sent again until the retry rule expires it', async () => {
    const sends: string[] = []
    const paths = setup()
    let t = Date.now()
    const q = createQueue({
      ...paths, log: () => {}, now: () => t, sendTimeoutMs: 10,
      send: n => { sends.push(content(n)); return new Promise(() => {}) },
    })
    q.open()
    await new Promise(r => setTimeout(r, 10))
    await q.enqueue(note('A'))
    expect(sends).toHaveLength(1)
    t += SEND_RETRY_MS * 2
    await q.pump()
    expect(sends).toHaveLength(1) // the first promise is still pending
    t += ACK_TIMEOUT_MS
    await q.pump()
    expect(sends).toHaveLength(2) // the retry rule expired it
  })

  test('without a gate, a send that times out and then delivers is removed, not sent again', async () => {
    const sends: string[] = []
    const paths = setup()
    let finish: () => void = () => {}
    const q = createQueue({
      ...paths, log: () => {}, sendTimeoutMs: 10,
      send: n => new Promise<void>(r => { sends.push(content(n)); finish = r }),
    })
    q.open()
    await new Promise(r => setTimeout(r, 10))
    await q.enqueue(note('A'))
    finish()
    await new Promise(r => setTimeout(r, 10))
    await q.pump()
    expect(sends).toEqual(['A'])
    expect(existsSync(paths.path)).toBe(false)
  })

  test('after a failed removal, the delivered head is removed again and never resent', async () => {
    const g = gatedSetup()
    await g.open()
    g.write('idle', SETTLE_MS)
    await g.q.enqueue(note('A'))
    await g.q.enqueue(note('B'))
    g.advance(1_000)
    g.write('busy')
    g.advance(1_000)
    g.write('idle')
    mkdirSync(`${g.path}.tmp-${process.pid}`) // a directory makes the rewrite fail
    await g.q.pump()
    expect(queued(g.path, g.corruptPath)).toEqual(['A', 'B'])
    g.advance(60_000)
    await g.q.pump()
    expect(g.sent).toEqual(['A']) // A is not sent again, and B waits behind it
    rmSync(`${g.path}.tmp-${process.pid}`, { recursive: true })
    await g.q.pump()
    expect(g.sent).toEqual(['A', 'B']) // A went out once; B follows after its removal
    expect(queued(g.path, g.corruptPath)).toEqual(['B'])
  })
})

describe('what is queued and who delivers', () => {
  test('holds a reaction in order with today\'s content and meta', async () => {
    const g = gatedSetup()
    const received: Notification[] = []
    const q = createQueue({
      path: g.path, corruptPath: g.corruptPath, log: () => {}, send: async n => { received.push(n) },
      readState: () => g.world.state, now: () => g.clock.t,
    })
    q.open()
    g.write('busy')
    const reaction: Notification = {
      method: 'notifications/claude/channel',
      params: {
        content: 'Reacted with 👍 to message_id 9',
        meta: { chat_id: '1', message_id: '9', kind: 'reaction', reaction_added: '👍', user: 'u', user_id: '2', ts: 't' },
      },
    }
    await q.enqueue(note('before'))
    await q.enqueue(reaction)
    await q.enqueue(note('after'))
    g.write('idle', SETTLE_MS)
    await q.pump()
    expect(received).toEqual([note('before')])
    for (let i = 0; i < 2; i++) {
      g.advance(1_000); g.write('busy'); g.advance(1_000); g.write('idle')
      await q.pump()
      g.advance(SETTLE_MS)
      await q.pump()
    }
    expect(received).toEqual([note('before'), reaction, note('after')])
  })

  test('QUEUED_REACTION is on the Telegram allowlist', () => {
    const types = readFileSync(
      join(import.meta.dir, '..', 'node_modules', '@grammyjs', 'types', 'message.d.ts'), 'utf8',
    )
    const union = types.split('\n').find(l => l.includes('emoji: "👍"'))
    expect(union).toBeDefined()
    expect(union!).toContain(`"${QUEUED_REACTION}"`)
    expect(QUEUED_REACTION).toBe('🫡')
  })

  test('does not deliver when bot.pid names another process', async () => {
    const g = gatedSetup()
    await g.open()
    g.world.owner = false
    g.write('idle', SETTLE_MS)
    expect(await g.q.enqueue(note('A'))).toBe('held')
    await g.q.pump()
    expect(g.sent).toEqual([])
    expect(queued(g.path, g.corruptPath)).toEqual(['A']) // appended, never lost
    g.world.owner = true
    await g.q.pump()
    expect(g.sent).toEqual(['A'])
  })

  test('delivers a line another process appended while the local queue was empty', async () => {
    const g = gatedSetup({ pollMs: 5 })
    await g.open()
    g.write('idle', SETTLE_MS)
    await new Promise(r => setTimeout(r, 20))
    appendEntry(g.path, note('from another process'))
    await waitFor(() => g.sent.length === 1)
    expect(g.sent).toEqual(['from another process'])
    g.q.close()
  })

  test('delivers without gating while queue-disabled exists', async () => {
    const g = gatedSetup()
    await g.open()
    g.world.disabled = true
    g.write('busy')
    appendEntry(g.path, note('A'))
    appendEntry(g.path, note('B'))
    expect(await g.q.enqueue(note('C'))).toBe('sent')
    expect(g.sent).toEqual(['A', 'B', 'C'])
    expect(existsSync(g.path)).toBe(false)
  })

  test('turning the kill switch on releases a head that awaits its turn', async () => {
    const g = gatedSetup()
    await g.open()
    g.write('idle', SETTLE_MS)
    await g.q.enqueue(note('A'))
    await g.q.enqueue(note('B'))
    g.world.disabled = true
    await g.q.pump()
    expect(g.sent).toEqual(['A', 'B'])
    expect(existsSync(g.path)).toBe(false)
  })

  test('runs the release hook after the send resolves, and a failing hook does not undo the send', async () => {
    const order: string[] = []
    const g = gatedSetup({
      onRelease: async () => { order.push('release'); throw new Error('reaction failed') },
      send: async () => { order.push('send') },
    })
    await g.open()
    g.write('idle', SETTLE_MS)
    expect(await g.q.enqueue(note('A'))).toBe('sent')
    expect(order).toEqual(['send', 'release'])
    expect(g.q.stats().inFlight).toBe(true)
  })

  test('a rejected send leaves the queued reaction on', async () => {
    let up = false
    const g = gatedSetup({ send: async () => { if (!up) throw new Error('MCP unreachable'); } })
    await g.open()
    g.write('busy')
    expect(await g.q.enqueue(note('A'))).toBe('held') // 🫡 goes on
    g.write('idle', SETTLE_MS)
    for (let i = 0; i < 3; i++) {
      g.advance(SEND_RETRY_MS)
      await g.q.pump()
    }
    expect(g.released).toEqual([]) // the release hook, which clears 🫡, never ran
    up = true
    g.advance(SEND_RETRY_MS)
    await g.q.pump()
    expect(g.released).toEqual(['A'])
  })

  test('tells the release hook whether the entry waited', async () => {
    const seen: [string, boolean][] = []
    const g = gatedSetup({ onRelease: async (n, info) => { seen.push([content(n), info.fresh]) } })
    await g.open()
    g.write('idle', SETTLE_MS)
    await g.q.enqueue(note('immediate')) // appended and released by the same call
    g.advance(1_000); g.write('busy')
    await g.q.enqueue(note('waited'))
    g.advance(1_000); g.write('idle')
    await g.q.pump() // removes "immediate"
    g.advance(SETTLE_MS)
    await g.q.pump() // releases "waited" from a later pass
    expect(seen).toEqual([['immediate', true], ['waited', false]])
  })

  test('close stops delivery and the poll timer', async () => {
    const g = gatedSetup({ pollMs: 5 })
    await g.open()
    g.q.close()
    g.write('idle', SETTLE_MS)
    appendEntry(g.path, note('late'))
    await new Promise(r => setTimeout(r, 40))
    await g.q.pump()
    expect(g.sent).toEqual([])
    expect(queued(g.path, g.corruptPath)).toEqual(['late'])
  })

  test('stats reports the depth and whether the head awaits its turn', async () => {
    const g = gatedSetup()
    await g.open()
    g.write('idle', SETTLE_MS)
    await g.q.enqueue(note('A'))
    await g.q.enqueue(note('B'))
    expect(g.q.stats()).toEqual({ depth: 2, inFlight: true })
  })

  test('permission notifications never pass through enqueue', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'server.ts'), 'utf8')
    const permission = [...source.matchAll(/mcp\.notification\(\{\s*method: 'notifications\/claude\/channel\/permission'/g)]
    expect(permission.length).toBeGreaterThanOrEqual(2) // the button and the "yes xxxxx" reply
    expect(source).not.toMatch(/notifyOrQueue\(\{\s*method: 'notifications\/claude\/channel\/permission/)
    expect(source).not.toMatch(/queue\.enqueue\(\{\s*method: 'notifications\/claude\/channel\/permission/)
    // The queue is only entered through notifyOrQueue.
    expect([...source.matchAll(/queue\.enqueue\(/g)].length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Review round 1 folds (dlucian/ezri#474).

describe('recheck before send', () => {
  test('keeps the entry queued, and its queued reaction, when the session became busy after the decision', async () => {
    let reads = 0
    const g = gatedSetup()
    const q = createQueue({
      path: g.path, corruptPath: g.corruptPath, log: () => {}, send: async n => { g.sent.push(content(n)) },
      // The decision sees an idle, settled session. By the recheck a terminal prompt has started a turn.
      readState: () => (++reads <= 1 ? { state: 'idle', mtimeMs: g.clock.t - SETTLE_MS } : { state: 'busy', mtimeMs: g.clock.t }),
      onRelease: async n => { g.released.push(content(n)) },
      now: () => g.clock.t,
    })
    q.open()
    await new Promise(r => setTimeout(r, 10))
    reads = 0
    expect(await q.enqueue(note('A'))).toBe('held')
    expect(g.sent).toEqual([])
    expect(g.released).toEqual([]) // the release hook, which clears the reaction, never ran
    expect(queued(g.path, g.corruptPath)).toEqual(['A'])
    expect(q.stats().inFlight).toBe(false)
  })

  test('sends once the recheck sees the session idle again', async () => {
    const g = gatedSetup()
    await g.open()
    g.write('busy')
    await g.q.enqueue(note('A'))
    g.write('idle')
    g.advance(SETTLE_MS)
    await g.q.pump()
    expect(g.sent).toEqual(['A'])
  })

  test('does not resend when the session wrote its state between the check and the resend', async () => {
    const g = gatedSetup()
    const script: (SessionState | null)[] = []
    const q = createQueue({
      path: g.path, corruptPath: g.corruptPath, log: () => {}, send: async n => { g.sent.push(content(n)) },
      readState: () => (script.length > 1 ? script.shift()! : script[0] ?? null),
      now: () => g.clock.t,
    })
    q.open()
    await new Promise(r => setTimeout(r, 10))
    script.push({ state: 'idle', mtimeMs: g.clock.t - SETTLE_MS })
    await q.enqueue(note('A'))
    expect(g.sent).toEqual(['A'])
    const sentAt = g.clock.t
    g.advance(ACK_TIMEOUT_MS)
    // The pass reads no write since the send, so it decides to resend. The recheck sees the turn start.
    script.splice(0, script.length, { state: 'idle', mtimeMs: sentAt - 1 }, { state: 'busy', mtimeMs: sentAt + 1 })
    await q.pump()
    expect(g.sent).toEqual(['A'])
    expect(readEntries(g.path, g.corruptPath, () => {})[0]!.attempts).toBe(1)
  })
})

describe('queue lock', () => {
  const child = join(import.meta.dir, 'fixtures', 'append-child.ts')

  test('an append from a second process while a rewrite holds the lock survives', async () => {
    const { path, corruptPath, dir } = setup()
    const ready = join(dir, 'child-ready')
    const idA = appendEntry(path, note('A'))
    appendEntry(path, note('B'))
    let proc!: ReturnType<typeof Bun.spawn>
    // This block is what removeEntry does: read, drop a line, rename. The second
    // process starts appending after the read and before the rename.
    withQueueLock(path, () => {}, () => {
      const snapshot = readFileSync(path, 'utf8').split('\n').filter(l => l.trim())
      proc = Bun.spawn(['bun', child, path, ready, 'from the second process'], { stdout: 'ignore', stderr: 'ignore' })
      const end = Date.now() + 10_000
      while (!existsSync(ready) && Date.now() < end) Bun.sleepSync(2)
      Bun.sleepSync(30) // the child now waits for the lock, which it gives up after LOCK_WAIT_MS
      const kept = snapshot.filter(l => !l.includes(`"${idA}"`))
      writeFileSync(`${path}.tmp-x`, kept.join('\n') + '\n')
      renameSync(`${path}.tmp-x`, path)
    })
    await proc.exited
    expect(queued(path, corruptPath)).toEqual(['B', 'from the second process'])
  })

  test('removeEntry holds the lock while it rewrites', () => {
    const { path } = setup()
    const id = appendEntry(path, note('A'))
    appendEntry(path, note('B'))
    // A busy lock makes removeEntry wait for LOCK_WAIT_MS and then go ahead.
    writeFileSync(`${path}.lock`, 'someone else')
    const logs: string[] = []
    const started = Date.now()
    removeEntry(path, id, m => logs.push(m))
    expect(Date.now() - started).toBeGreaterThanOrEqual(LOCK_WAIT_MS - 20)
    expect(logs.some(m => m.includes('continuing without it'))).toBe(true)
    expect(readFileSync(path, 'utf8')).not.toContain('"A"')
  })

  test('a stale lock does not block', () => {
    const { path } = setup()
    writeFileSync(`${path}.lock`, 'crashed process')
    const old = new Date(Date.now() - LOCK_STALE_MS - 1_000)
    utimesSync(`${path}.lock`, old, old)
    const logs: string[] = []
    const started = Date.now()
    appendEntry(path, note('A'), Date.now(), m => logs.push(m))
    expect(Date.now() - started).toBeLessThan(LOCK_WAIT_MS - 50)
    expect(logs).toEqual([])
    expect(existsSync(`${path}.lock`)).toBe(false) // taken over, then released
    expect(readFileSync(path, 'utf8')).toContain('"A"')
  })

  test('an unacquirable lock still appends', () => {
    const { path, corruptPath } = setup()
    writeFileSync(`${path}.lock`, 'held by a live process') // fresh, so not stale
    const logs: string[] = []
    appendEntry(path, note('A'), Date.now(), m => logs.push(m))
    expect(queued(path, corruptPath)).toEqual(['A'])
    expect(logs.some(m => m.includes('continuing without it'))).toBe(true)
    expect(readFileSync(`${path}.lock`, 'utf8')).toBe('held by a live process') // never released by a non-holder
  })

  test('a lock that cannot be created still appends', () => {
    const { path, corruptPath } = setup()
    mkdirSync(`${path}.lock`) // a directory: EEXIST but never stale-breakable by rm without recursion
    const old = new Date(Date.now() - 60_000)
    utimesSync(`${path}.lock`, old, old)
    appendEntry(path, note('A'))
    expect(queued(path, corruptPath)).toEqual(['A'])
  })

  test('releases the lock when the rewrite throws', () => {
    const { path } = setup()
    appendEntry(path, note('A'))
    appendEntry(path, note('B'))
    const id = readEntries(path, '/dev/null', () => {})[0]!.key
    mkdirSync(`${path}.tmp-${process.pid}`) // a directory makes the rewrite fail
    expect(() => removeEntry(path, id)).toThrow()
    expect(existsSync(`${path}.lock`)).toBe(false)
  })

  test('does not remove a lock that another process took over', () => {
    const { path } = setup()
    withQueueLock(path, () => {}, () => {
      // A stale-lock breaker replaced our lock while we held it.
      writeFileSync(`${path}.lock`, 'someone else')
    })
    expect(readFileSync(`${path}.lock`, 'utf8')).toBe('someone else')
  })

  test('releases the lock after a normal append and rewrite', () => {
    const { path } = setup()
    const id = appendEntry(path, note('A'))
    expect(existsSync(`${path}.lock`)).toBe(false)
    setAttempts(path, id, 1)
    removeEntry(path, id)
    expect(existsSync(`${path}.lock`)).toBe(false)
  })
})

describe('give-up warning', () => {
  test('a failed removal after the warning retries only the removal', async () => {
    const g = gatedSetup()
    await g.open()
    g.write('idle', SETTLE_MS)
    await g.q.enqueue(note('A'))
    await g.q.enqueue(note('B'))
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
      g.advance(ACK_TIMEOUT_MS)
      await g.q.pump()
    }
    mkdirSync(`${g.path}.tmp-${process.pid}`) // removal now fails
    g.advance(ACK_TIMEOUT_MS)
    await g.q.pump()
    expect(g.warns).toHaveLength(1)
    for (let i = 0; i < 5; i++) {
      g.advance(1_000)
      await g.q.pump()
    }
    expect(g.warns).toHaveLength(1) // not once per poll
    expect(g.sent.filter(c => c === 'A')).toHaveLength(MAX_ATTEMPTS)
    rmSync(`${g.path}.tmp-${process.pid}`, { recursive: true })
    await g.q.pump()
    expect(queued(g.path, g.corruptPath)[0]).toBe('B')
    expect(g.warns).toHaveLength(1)
  })
})

describe('server.ts shutdown', () => {
  test('does not remove the session marker', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'server.ts'), 'utf8')
    const start = src.indexOf('function shutdown(): void {')
    const body = src.slice(start, src.indexOf("process.stdin.on('end', shutdown)", start))
    expect(start).toBeGreaterThan(0)
    expect(body).toContain('queue.close()')
    // The only file the shutdown removes is bot.pid.
    expect([...body.matchAll(/rmSync\(([^)]*)\)/g)].map(m => m[1])).toEqual(['PID_FILE'])
    // The sweep of dead processes' markers is the only removal.
    expect(src).toMatch(/sweepDeadStateFiles\(STATE_DIR, log\)/)
  })
})

describe('kill switch and read errors', () => {
  test('queue-disabled retries only the removal after a failed removal, over several polls', async () => {
    const g = gatedSetup()
    await g.open()
    g.world.disabled = true
    appendEntry(g.path, note('A'))
    appendEntry(g.path, note('B'))
    mkdirSync(`${g.path}.tmp-${process.pid}`) // removal now fails
    await g.q.pump()
    for (let i = 0; i < 5; i++) {
      g.advance(1_000)
      await g.q.pump()
    }
    expect(g.sent).toEqual(['A']) // not once per poll
    rmSync(`${g.path}.tmp-${process.pid}`, { recursive: true })
    await g.q.pump()
    expect(g.sent).toEqual(['A', 'B'])
    expect(existsSync(g.path)).toBe(false)
  })

  test('a removal failure that began in gated mode still retries only the removal when the kill switch comes on', async () => {
    const g = gatedSetup()
    await g.open()
    g.write('idle', SETTLE_MS)
    await g.q.enqueue(note('A'))
    await g.q.enqueue(note('B'))
    g.advance(1_000); g.write('busy'); g.advance(1_000); g.write('idle')
    mkdirSync(`${g.path}.tmp-${process.pid}`)
    await g.q.pump() // the turn ended, removal fails
    g.world.disabled = true
    for (let i = 0; i < 3; i++) {
      g.advance(1_000)
      await g.q.pump()
    }
    expect(g.sent).toEqual(['A'])
    rmSync(`${g.path}.tmp-${process.pid}`, { recursive: true })
    await g.q.pump()
    expect(g.sent).toEqual(['A', 'B'])
  })

  test('a read failure keeps the in-flight state and sends nothing again', async () => {
    const g = gatedSetup()
    await g.open()
    g.write('idle', SETTLE_MS)
    await g.q.enqueue(note('A'))
    const moved = `${g.path}.moved`
    renameSync(g.path, moved)
    mkdirSync(g.path) // reading a directory fails with EISDIR, which is not "missing"
    for (let i = 0; i < 4; i++) {
      g.advance(1_000)
      await g.q.pump()
    }
    expect(g.logs.some(m => m.includes('cannot read'))).toBe(true)
    rmSync(g.path, { recursive: true })
    renameSync(moved, g.path)
    g.advance(1_000)
    await g.q.pump()
    expect(g.sent).toEqual(['A']) // still accounted for: no resend inside the ack window
    g.advance(1_000); g.write('busy'); g.advance(1_000); g.write('idle')
    await g.q.pump()
    expect(existsSync(g.path)).toBe(false) // the turn's end still removes it
  })

  test('a read failure keeps the pending removal', async () => {
    const g = gatedSetup()
    await g.open()
    g.write('idle', SETTLE_MS)
    await g.q.enqueue(note('A'))
    await g.q.enqueue(note('B'))
    g.advance(1_000); g.write('busy'); g.advance(1_000); g.write('idle')
    mkdirSync(`${g.path}.tmp-${process.pid}`)
    await g.q.pump() // removal of A fails, so it is pending
    rmSync(`${g.path}.tmp-${process.pid}`, { recursive: true })
    const moved = `${g.path}.moved`
    renameSync(g.path, moved)
    mkdirSync(g.path)
    g.advance(60_000)
    await g.q.pump()
    rmSync(g.path, { recursive: true })
    renameSync(moved, g.path)
    g.advance(1_000)
    await g.q.pump()
    expect(g.sent).toEqual(['A', 'B']) // A went out once, and its removal finished after the read recovered
  })

  test('a missing file and an empty file still clear the in-flight state', async () => {
    const g = gatedSetup()
    await g.open()
    g.write('idle', SETTLE_MS)
    await g.q.enqueue(note('A'))
    expect(g.q.stats().inFlight).toBe(true)
    rmSync(g.path)
    await g.q.pump()
    expect(g.q.stats().inFlight).toBe(false)
    await g.q.enqueue(note('B'))
    writeFileSync(g.path, '')
    await g.q.pump()
    expect(g.q.stats().inFlight).toBe(false)
  })
})
