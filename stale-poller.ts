// Pure helper for the startup scan for stale Telegram pollers in server.ts.
// Kept free of side effects so tests can import it without starting the bot.

// Cache path of this fork, `telegram@claudegram`.
const CLAUDEGRAM_CACHE = '/.claude/plugins/cache/claudegram/telegram/'
// Cache path of the official plugin. `ezri-claudegram-rollback` switches the
// session to this copy, so the scan keeps matching it.
const OFFICIAL_CACHE = '/.claude/plugins/cache/claude-plugins-official/telegram/'

/**
 * Returns true when `cmd` is the wrapper process that launches the Telegram
 * plugin: a `bun run` command line that names a Telegram plugin cache path.
 */
export function isPluginWrapper(cmd: string): boolean {
  return cmd.includes('bun run') &&
    (cmd.includes(CLAUDEGRAM_CACHE) || cmd.includes(OFFICIAL_CACHE))
}
