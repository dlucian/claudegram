import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// The hook runs for real, as a subprocess, against a temporary state directory
// and a stub detector. Nothing here reads the live state directory or looks at
// a real claude process.

const HOOK = join(import.meta.dir, '..', 'hooks', 'session-state.sh')
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup(detector: { rc: number; out?: string } = { rc: 0, out: '4242' }) {
  const root = mkdtempSync(join(tmpdir(), 'session-state-hook-'))
  dirs.push(root)
  const stateDir = join(root, 'state')
  const stub = join(root, 'detect.sh')
  writeFileSync(
    stub,
    `#!/usr/bin/env bash\n[ "$1" = "--print-pid" ] || exit 2\n${detector.out !== undefined ? `printf '%s\\n' '${detector.out}'\n` : ''}exit ${detector.rc}\n`,
  )
  chmodSync(stub, 0o755)
  return { root, stateDir, stub, file: (pid = 4242) => join(stateDir, 'session-state', String(pid)) }
}

function run(
  action: string,
  env: { stateDir: string; stub: string; root: string },
  stdin = '{}',
  extra: Record<string, string> = {},
) {
  const proc = Bun.spawnSync(['/bin/bash', HOOK, action], {
    stdin: new TextEncoder().encode(stdin),
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: env.root,
      TELEGRAM_STATE_DIR: env.stateDir,
      CLAUDEGRAM_CHANNEL_DETECT: env.stub,
      ...extra,
    },
  })
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() }
}

const word = (path: string) => readFileSync(path, 'utf8').trim()

describe('gate', () => {
  test('writes nothing when the detector exits 1 or 2', () => {
    for (const rc of [1, 2]) {
      const s = setup({ rc, out: '4242' })
      for (const action of ['idle', 'busy', 'tool']) {
        const r = run(action, s)
        expect(r.code).toBe(0)
        expect(r.stdout).toBe('')
      }
      expect(existsSync(join(s.stateDir, 'session-state'))).toBe(false)
    }
  })

  test('writes nothing when an older detector reads --print-pid as a PID', () => {
    // The real script exits 2 for a non-numeric PID; this stub does the same and prints nothing.
    const s = setup({ rc: 2 })
    expect(run('idle', s).code).toBe(0)
    expect(existsSync(join(s.stateDir, 'session-state'))).toBe(false)
  })

  test('writes nothing when the detector prints something that is not a PID', () => {
    for (const out of ['', 'abc', '12 34', '1', '0', '-5']) {
      const s = setup({ rc: 0, out })
      expect(run('idle', s).code).toBe(0)
      expect(existsSync(join(s.stateDir, 'session-state'))).toBe(false)
    }
  })

  test('writes to the file named by the detector\'s PID', () => {
    const s = setup({ rc: 0, out: '777' })
    run('busy', s)
    expect(word(s.file(777))).toBe('busy')
    expect(readdirSync(join(s.stateDir, 'session-state'))).toEqual(['777'])
  })

  test('ignores an unknown action', () => {
    const s = setup()
    expect(run('reboot', s).code).toBe(0)
    expect(existsSync(join(s.stateDir, 'session-state'))).toBe(false)
  })
})

describe('events', () => {
  test('writes busy, then idle, atomically for each mapped event', () => {
    const s = setup()
    const steps: [string, string][] = [
      ['idle', 'idle'], // SessionStart, Stop, StopFailure, idle_prompt
      ['busy', 'busy'], // UserPromptSubmit
      ['tool', 'busy'], // PreToolUse on the main thread
      ['idle', 'idle'],
    ]
    for (const [action, expected] of steps) {
      const r = run(action, s, '{"tool_name":"Bash"}')
      expect(r.code).toBe(0)
      expect(r.stdout).toBe('')
      expect(word(s.file())).toBe(expected)
      // The write goes through a temp file and a rename, so none is left behind.
      expect(readdirSync(join(s.stateDir, 'session-state'))).toEqual(['4242'])
    }
  })

  test('creates the state directory with owner-only permissions', () => {
    const s = setup()
    run('idle', s)
    expect(statSync(join(s.stateDir, 'session-state')).mode & 0o777).toBe(0o700)
  })
})

describe('subagents', () => {
  test('an agent_id event never turns idle into busy', () => {
    const s = setup()
    run('idle', s)
    run('tool', s, '{"agent_id":"agent-1","tool_name":"Read"}')
    expect(word(s.file())).toBe('idle')
    // With no file at all, a subagent event creates none either.
    const fresh = setup()
    run('tool', fresh, '{"agent_id":"agent-1"}')
    expect(existsSync(fresh.file())).toBe(false)
  })

  test('an agent_id event refreshes the mtime while busy', () => {
    const s = setup()
    run('busy', s)
    const old = new Date(Date.now() - 600_000)
    utimesSync(s.file(), old, old)
    run('tool', s, '{"agent_id":"agent-1"}')
    expect(word(s.file())).toBe('busy')
    expect(Date.now() - statSync(s.file()).mtimeMs).toBeLessThan(30_000)
  })

  test('tool input that mentions agent_id counts as main thread', () => {
    const s = setup()
    run('idle', s)
    const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo "agent_id" \'{"agent_id":"x"}\'' } })
    run('tool', s, input)
    expect(word(s.file())).toBe('busy')
  })

  test('a null or empty agent_id counts as main thread', () => {
    for (const input of ['{"agent_id":null}', '{"agent_id":""}', '{}']) {
      const s = setup()
      run('idle', s)
      run('tool', s, input)
      expect(word(s.file())).toBe('busy')
    }
  })
})

describe('failure modes', () => {
  test('exits 0 with empty stdout on an unwritable directory', () => {
    const s = setup()
    mkdirSync(s.stateDir, { recursive: true })
    chmodSync(s.stateDir, 0o500)
    try {
      const r = run('idle', s)
      expect(r.code).toBe(0)
      expect(r.stdout).toBe('')
      expect(r.stderr).toBe('')
    } finally {
      chmodSync(s.stateDir, 0o700)
    }
    // A regular file where the directory should be.
    const blocked = setup()
    writeFileSync(blocked.stateDir, 'not a directory')
    const r = run('busy', blocked)
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
  })

  test('treats bad JSON as a subagent event: refresh only, never busy', () => {
    const s = setup()
    run('idle', s)
    const r = run('tool', s, 'this is {not json')
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
    expect(word(s.file())).toBe('idle')
  })

  test('treats a non-object JSON value as a subagent event', () => {
    const s = setup()
    run('idle', s)
    run('tool', s, '[1,2,3]')
    expect(word(s.file())).toBe('idle')
  })

  test('exits 0 and refreshes only when jq is missing', () => {
    const s = setup()
    run('busy', s)
    const old = new Date(Date.now() - 600_000)
    utimesSync(s.file(), old, old)
    // A PATH with bash tools but no jq.
    const bin = join(s.root, 'bin')
    mkdirSync(bin)
    for (const tool of ['bash', 'head', 'cat', 'mkdir', 'mv', 'rm', 'touch', 'printf']) {
      const found = Bun.spawnSync(['which', tool]).stdout.toString().trim()
      if (found) Bun.spawnSync(['ln', '-s', found, join(bin, tool)])
    }
    const r = run('tool', s, '{"tool_name":"Bash"}', { PATH: bin })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
    expect(word(s.file())).toBe('busy')
    expect(Date.now() - statSync(s.file()).mtimeMs).toBeLessThan(30_000) // refreshed, as for a subagent
    run('idle', s, '{}', { PATH: bin })
    expect(word(s.file())).toBe('idle')
    run('tool', s, '{"tool_name":"Bash"}', { PATH: bin })
    expect(word(s.file())).toBe('idle') // without jq a tool call cannot flip idle to busy
  })

  test('exits 0 when the detector is missing', () => {
    const s = setup()
    rmSync(s.stub)
    expect(run('idle', s).code).toBe(0)
    expect(existsSync(join(s.stateDir, 'session-state'))).toBe(false)
  })
})

describe('hooks.json', () => {
  const hooks = JSON.parse(readFileSync(join(import.meta.dir, '..', 'hooks', 'hooks.json'), 'utf8')).hooks as Record<
    string,
    { matcher?: string; hooks: { command: string; timeout?: number }[] }[]
  >
  const commandsFor = (event: string) => hooks[event]!.flatMap(g => g.hooks.map(h => h.command))

  test('excludes compact from the SessionStart matcher', () => {
    expect(hooks.SessionStart).toHaveLength(1)
    const matcher = hooks.SessionStart![0]!.matcher!
    expect(matcher.split('|').sort()).toEqual(['clear', 'resume', 'startup'])
    expect(matcher).not.toContain('compact')
  })

  test('maps each event to its action', () => {
    const action = (event: string) => commandsFor(event).filter(c => c.includes('session-state.sh')).map(c => c.split(' ').pop())
    expect(action('SessionStart')).toEqual(['idle'])
    expect(action('UserPromptSubmit')).toEqual(['busy'])
    expect(action('PreToolUse')).toEqual(['tool'])
    expect(action('Stop')).toEqual(['idle'])
    expect(action('StopFailure')).toEqual(['idle'])
    expect(action('Notification')).toEqual(['idle'])
    expect(hooks.Notification![0]!.matcher).toBe('idle_prompt')
    expect(hooks.PreToolUse![0]!.matcher).toBe('*')
  })

  test('keeps the Stop mirror and bounds every state hook', () => {
    expect(commandsFor('Stop').some(c => c.includes('stop-mirror.py'))).toBe(true)
    for (const groups of Object.values(hooks)) {
      for (const g of groups) {
        for (const h of g.hooks) {
          if (h.command.includes('session-state.sh')) expect(h.timeout).toBeLessThanOrEqual(5)
        }
      }
    }
  })
})
