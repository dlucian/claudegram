# claudegram

**Telegram for Claude Code — but better.** An enhanced, self-maintained fork of Anthropic's official Telegram plugin (`anthropics/claude-plugins-official` → `telegram`), carrying a set of real-world improvements built while running Telegram as the primary channel for an always-on Claude Code agent.

Upstream is a large plugin *catalog* (telegram is one of many), the telegram plugin itself is largely feature-static, and external PRs are auto-rejected — so these enhancements live here instead, as first-class code rather than patches reapplied after every upgrade.

## What it adds over upstream

The single MCP server (`server.ts`) extends the stock plugin with:

- 🎙️ **Voice notes** — send `.ogg`/`.opus`/`.oga` files as native Telegram voice messages (`sendVoice`), not documents.
- 📥 **Durable inbound** — inbound messages are persisted and replayed, so nothing is lost if no session is listening the moment they arrive.
- ♻️ **Poller hygiene** — cleans up zombie/duplicate long-poller processes that otherwise fight over `getUpdates`.
- 🤫 **Headless skip** — well-behaved in non-interactive/headless contexts.
- 👍 **Inbound reactions** — surfaces emoji reactions on your messages as structured inbound events.
- 📝 **Transcripts** — append-only inbound/outbound transcript logging (with Telegram-side timestamps) for durable history beyond Telegram's no-history Bot API.
- ✍️ **Markdown that just works** — write natural Markdown (`*bold*`, `_italic_`, `` `code` ``, `[text](url)`); the plugin escapes to MarkdownV2 for you (an audit of historical replies showed a ~13% escape-failure rate when callers hand-rolled escapes — this kills that class of bug).
- 📍 **Location ingest** — handles inbound location/pin messages.
- 🫡 **Hold until idle** — a message that arrives mid-turn waits in the queue until the session is idle, so it normally starts its own turn instead of folding into the running one with a mid-turn note. See [Message queueing](#message-queueing).

## Bundled hooks (operator-specific)

`hooks/hooks.json` ships a **Stop hook** (`hooks/stop-mirror.py`) that auto-sends the agent's final turn text to Telegram — so the operator can just write the answer and it reaches Telegram, formatted and **threaded** under the message that triggered the turn, with no explicit `reply` tool call. The explicit `reply` tool stays for what a hook can't do: attachments, voice notes, reactions, and deliberate multi-message splits. Guards: a double-send carve-out (skips when a Telegram tool was already used in the turn), `EZRI_TG_MIRROR=0` kill switch, secret scrub, and a terminal-only (no-channel) skip.

> **Scope:** this hook is **operator-specific**, not a generic upstream feature — it gates on an `~/ezri` project marker and delegates the actual send to `~/ezri/bin/ezri-tg-send`, so it silently no-ops outside that setup. Threading parses the inbound `message_id` only from the turn's trigger record (immune to stale ids elsewhere in the transcript). Formatting parity with the `reply` tool is *by-convention* (both target MarkdownV2 with a plain-text fallback), not yet cross-checked by a golden test. Internalizing send/escape into the plugin (dropping the `~/ezri` dependency) is the tracked next step.

### On the roadmap (from the agent that runs this)

- 🧵 **Auto reply-threading** — ✅ shipped as part of the auto-send hook above (parses the trigger message_id; falls back to un-threaded for terminal-typed turns).
- 🛠️ **Live tool-use display** — a single self-updating message showing what the agent is doing in real time.

## Message queueing

The plugin holds each inbound message in `pending_notifications.jsonl` until the session that owns the channel is idle, then delivers one message and waits for that turn to end before it delivers the next. Without this, a message that arrives mid-turn folds into the running turn with a mid-turn note, and the session can decline it.

**How it works**

- Hooks in `hooks/hooks.json` run `hooks/session-state.sh`, which writes `busy` or `idle` to `$TELEGRAM_STATE_DIR/session-state/<claude_pid>`. The plugin reads only the file of its own `claude` ancestor, so another session can't mark it busy or idle.
- A held message gets a 🫡 reaction. The plugin clears the reaction when it releases the message. Reactions and `ask` taps queue in order without a 🫡, and an `ask` tap shows a `Queued: <label>` toast instead of `Sent: <label>`.
- The plugin re-reads the marker immediately before each send and keeps the message queued if the session became busy.
- The plugin keeps a delivered message in the queue until a turn ends after the send, because `mcp.notification` resolving doesn't prove that the harness registered its channel handler. If the session writes no state within 30 seconds, the plugin sends the message again, up to three times, and then tells you that it dropped the message.
- **Limit of the acknowledgement.** The marker doesn't say which turn it describes. Any turn that starts after the send counts as the acknowledgement. A message that the harness silently dropped in that same window can therefore be removed unseen, and a turn that starts between the plugin's last check of the marker and the send can still absorb the message.
- Every writer of `pending_notifications.jsonl` takes a lock file next to it (`pending_notifications.jsonl.lock`) so that a rewrite in one process can't erase a line that another process appends. A writer waits at most 200 ms for the lock, breaks a lock older than 2 seconds, and goes ahead without the lock if it can't get one. A stuck lock never blocks an inbound message.
- Permission requests, `yes xxxxx` replies, and `perm:` buttons never queue.

**Every uncertain state delivers.** A missing or unreadable state file, a `busy` marker older than 15 minutes, and a message that waited longer than 30 minutes (the head of the queue only) all release the message. The cost of a wrong signal is a labeled or duplicate message, never a message that waits forever.

| Constant | Value | Meaning |
|---|---|---|
| `POLL_MS` | 1 s | How often the queue file is checked. |
| `SETTLE_MS` | 3 s | How long the state must stay `idle` before a release. |
| `STALE_BUSY_MS` | 15 min | A `busy` marker not rewritten for this long no longer counts. |
| `MAX_HOLD_MS` | 30 min | The age at which the head becomes eligible for fail-open release under a fresh `busy` marker. |
| `FAIL_OPEN_SPACING_MS` | 30 s | The spacing between fail-open releases. |
| `ACK_TIMEOUT_MS` | 30 s | How long a delivered message waits for any state write before the resend. |
| `MAX_ATTEMPTS` | 3 | The most sends of one message without a turn. |

Fail-open releases go out one per `FAIL_OPEN_SPACING_MS`, in queue order. The second and later messages of a backlog therefore wait longer than 30 minutes, and a backlog of n expired messages takes about n × 30 seconds to drain.

**Check it.** Send `/status` to the bot. It reports the session state, how many messages are held, and whether queueing is off.

**Turn it off.** Create `$TELEGRAM_STATE_DIR/queue-disabled`. While the file exists, the plugin sends every entry at once and removes it at send. Delete the file to turn queueing back on.

**Roll back.** `ezri-claudegram-rollback` switches to the official plugin, which doesn't read the queue the same way. Check that the queue is empty first, or create `queue-disabled` and wait for it to drain.

The hook needs `jq` to tell a subagent's tool call from the main thread. Without `jq` the hook still works, but a tool call can't turn an idle session busy.

## Status

Working baseline mirrors the live, patched plugin. Install/marketplace wiring and the roadmap items above are in progress.

## License

MIT (see `LICENSE`). Built on Anthropic's official Telegram plugin; thanks upstream for the foundation.
