# Deploying claudegram (git-native, since 2026-07-23)

This fork **is** the source of truth. There is no patch layer any more (the old
`~/ezri/patches/telegram-plugin/` + `apply.sh` reapply dance was retired
2026-07-23 — it ran in parallel to git and caused drift). One system now: git.

## The deploy ritual

1. Edit `server.ts` (or whatever) here in the fork.
2. **Bump the version** in `.claude-plugin/plugin.json` (e.g. `0.0.8` → `0.0.9`).
   This is the trigger — `claude plugin update` only re-pulls when the version
   changes. Skipping the bump = the deploy silently no-ops.
3. Test and typecheck: `bun test`, then
   `bun build server.ts --target node --outfile /tmp/x.js` (no tsconfig, so
   this bundle IS the parse/type gate; ~255 modules = clean).
4. Commit + push to `github.com/dlucian/claudegram` (the marketplace source).
   Use the ezri-helper bot: `GH_TOKEN="$EZRI_GH_TOKEN" git push`.
5. Pull it into the live cache:
   ```
   claude plugin marketplace update claudegram      # re-pull github HEAD
   claude plugin update telegram@claudegram          # stage new version in cache
   ```
6. **Verify** the new cache byte-matches the fork before trusting it.
   `server.ts` imports `permission-format.ts`, `stale-poller.ts`, and
   `notif-queue.ts`, so compare all four files: a cache with a stale or missing
   import fails at startup even when `server.ts` matches. Compare the hook
   files too: `hooks/session-state.sh` writes the busy or idle marker that the
   queue reads, and `hooks/hooks.json` registers it.
   ```
   V=$(python3 -c "import json;print(json.load(open('.claude-plugin/plugin.json'))['version'])")
   for f in server.ts permission-format.ts stale-poller.ts notif-queue.ts \
            hooks/session-state.sh hooks/hooks.json; do
     diff <(git show HEAD:$f) \
       "$HOME/.claude/plugins/cache/claudegram/telegram/$V/$f" && echo "OK $f"
   done
   ```
7. **Restart to apply** — the running `bun` plugin process only loads new code on
   a session restart. Safe path: `ezri-rotate-session` (self-verifying, pings
   Telegram on failure) or ride the nightly 00:00 UTC rotation (zero downtime).
   Once live, `/clear` on Telegram is the one-tap rotation.

## Why this replaced patches

The plugin manager pins the install to a **git commit** (`installed_plugins.json`
→ `gitCommitSha`) and copies that commit's `server.ts` into a versioned cache
dir. Bumping the version + `plugin update` re-pulls HEAD — clean, versioned,
diff-able, no drift. The old model froze the cache at one commit and layered
`.patch` files on top, so any fork commit that wasn't also patchified never
reached the live plugin. Never again.

## Rollback

`~/ezri/bin/ezri-claudegram-rollback` re-enables the upstream
`telegram@claude-plugins-official` plugin and reverts the launch scripts. That
path is intentionally vanilla-upstream (no fork features) — it's the break-glass
option if claudegram itself is broken.
