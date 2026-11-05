import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { isPluginWrapper } from '../stale-poller.ts'

const HOME = '/Users/ezri'

describe('isPluginWrapper', () => {
  test('matches a bun run wrapper under the claudegram cache path', () => {
    const cmd = `bun run --cwd ${HOME}/.claude/plugins/cache/claudegram/telegram/0.0.11 --shell=bun --silent start`
    expect(isPluginWrapper(cmd)).toBe(true)
  })

  test('matches a bun run wrapper under the official cache path', () => {
    const cmd = `bun run --cwd ${HOME}/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6 --shell=bun --silent start`
    expect(isPluginWrapper(cmd)).toBe(true)
  })

  test('does not match a bun run wrapper for another plugin', () => {
    const cmd = `bun run --cwd ${HOME}/.claude/plugins/cache/claudegram/discord/0.0.1 --shell=bun --silent start`
    expect(isPluginWrapper(cmd)).toBe(false)
    const other = `bun run --cwd ${HOME}/.claude/plugins/cache/some-market/telegram/1.0.0 --silent start`
    expect(isPluginWrapper(other)).toBe(false)
  })

  test('does not match a non-bun process under the cache path', () => {
    expect(isPluginWrapper(`tail -f ${HOME}/.claude/plugins/cache/claudegram/telegram/0.0.11/server.ts`)).toBe(false)
    expect(isPluginWrapper(`node ${HOME}/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6/x.js`)).toBe(false)
  })
})

describe('server.ts wiring', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'server.ts'), 'utf8')

  test('server.ts uses isPluginWrapper and no longer defines PLUGIN_PATH_HINT', () => {
    expect(src).toContain("from './stale-poller.ts'")
    expect(src).toMatch(/isPluginWrapper\(p\.cmd\)/)
    expect(src).not.toContain('PLUGIN_PATH_HINT')
  })
})
