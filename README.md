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

### On the roadmap (from the agent that runs this)

- 🧵 **Auto reply-threading** — default `reply_to` to the triggering message so parallel conversation topics thread automatically.
- 🛠️ **Live tool-use display** — a single self-updating message showing what the agent is doing in real time.

## Status

Working baseline mirrors the live, patched plugin. Install/marketplace wiring and the roadmap items above are in progress.

## License

MIT (see `LICENSE`). Built on Anthropic's official Telegram plugin; thanks upstream for the foundation.
