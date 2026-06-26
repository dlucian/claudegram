#!/usr/bin/env python3
"""
claudegram Stop hook: mirror the agent's final non-tool text output to Telegram.

This is the first-class, versioned home of Ezri's auto-send (dlucian/ezri#80).
It ships WITH the plugin and registers via hooks/hooks.json — no
~/.claude/settings.json wiring. It supersedes the old external
~/ezri/bin/ezri-tg-stop-mirror, adding threading: the auto-send is quoted under
the inbound message that triggered the turn.

Triggers on every Claude Code turn-end. Reads the session transcript, finds the
last assistant message in the current turn, and if no Telegram reply tool was
invoked anywhere in that turn, forwards the text to Lucian's Telegram.

Skip conditions:
  - EZRI_TG_MIRROR=0 (env var kill switch)
  - Session is not in the ezri project (marker derived from ~/ezri)
  - The Telegram channel is inactive in this session (terminal-only launch)
  - The last assistant turn already called a Telegram reply/edit tool
  - Final text is empty, < 12 chars, or pure tool-narration sentinel

Threading (ezri#80):
  - The trigger record (turn-start) carries the inbound channel block; we parse
    message_id ONLY from that single record's opening <channel ...> tag, so a
    stale id embedded later in the turn slice (e.g. a recalled-memory block in a
    hook_additional_context attachment) can never be picked.
  - Both shapes covered: a normal/ask_answer inbound (type=user string) and a
    MID-TURN message (type=attachment / queued_command, block in attachment.prompt).
  - Terminal-typed turn (no channel block) → send un-threaded (today's behavior).

Self-containment note: this hook still shells to ~/ezri/bin/ezri-tg-send (the
proven sender, now with --reply-to) and ~/ezri/bin/ezri-tg-channel-active, and
gates on the ezri-project marker — so it is Ezri-specific, not a generic upstream
feature. Internalizing send/escape into the fork is the tracked follow-up.

Fire-and-forget: errors swallowed so it never breaks the session. Logs to
~/.claude/logs/tg-stop-mirror.log.
"""

from __future__ import annotations
import json
import os
import re
import sys
import time
import subprocess
from pathlib import Path

CHAT_ID = "36632230"
TOKEN_FILE = Path.home() / ".claude/channels/telegram/.env"
LOG_FILE = Path.home() / ".claude/logs/tg-stop-mirror.log"
# Host-derived project marker (the Claude project dir is the cwd with slashes →
# dashes). Never hardcode the user — derive from ~/ezri so a host move doesn't
# silently disable the mirror.
EZRI_PROJECT_MARKER = "-" + str(Path.home() / "ezri").strip("/").replace("/", "-")
CHANNEL_DETECT = str(Path.home() / "ezri/bin/ezri-tg-channel-active")
TG_SEND = str(Path.home() / "ezri/bin/ezri-tg-send")
MIN_TEXT_LEN = 12

SECRET_PATTERNS = [
    re.compile(r"sk_[a-zA-Z0-9_-]{20,}"),
    re.compile(r"sk-[a-zA-Z0-9_-]{20,}"),
    re.compile(r"ghp_[a-zA-Z0-9]{20,}"),
    re.compile(r"github_pat_[A-Z0-9_]{20,}"),
    re.compile(r"Bearer\s+[A-Za-z0-9._\-]{20,}"),
    re.compile(r"\b\d{9,}:AA[A-Za-z0-9_\-]{30,}"),  # Telegram bot tokens
    re.compile(r"xoxb-[a-zA-Z0-9-]{20,}"),
    re.compile(r"AIza[a-zA-Z0-9_\-]{30,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
]

TELEGRAM_TOOL_NAMES = {
    "mcp__plugin_telegram_telegram__reply",
    "mcp__plugin_telegram_telegram__edit_message",
}

NARRATION_PATTERNS = [
    re.compile(r"^(running|checking|let me|reading|spawning|loading)\b", re.I),
]

# Anchored to a <channel ...> (or HTML-escaped &lt;channel ...&gt;) tag at the
# START of the trigger text; message_id is read ONLY from inside that opening
# tag. This is what makes threading immune to stale ids elsewhere in the slice.
_CHANNEL_OPEN = re.compile(r'^\s*(?:<|&lt;)channel\b(.*?)(?:>|&gt;)', re.S)
_MSGID = re.compile(r'\bmessage_id="(\d+)"')


def log(msg: str) -> None:
    try:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with LOG_FILE.open("a") as f:
            f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {msg}\n")
    except Exception:
        pass


def channel_inactive() -> bool:
    """True only when the detector is CERTAIN this session has no Telegram
    channel (exit 1). On active (0) or undetermined (2) we return False so the
    mirror still fires — never go silent on the #1 path over a detection glitch."""
    try:
        rc = subprocess.run([CHANNEL_DETECT], timeout=4).returncode
    except Exception:
        return False
    return rc == 1


def load_token() -> str | None:
    try:
        for line in TOKEN_FILE.read_text().splitlines():
            if line.startswith("TELEGRAM_BOT_TOKEN="):
                return line.split("=", 1)[1].strip()
    except Exception as e:
        log(f"token load failed: {e}")
    return None


def scrub(text: str) -> str:
    for pat in SECRET_PATTERNS:
        text = pat.sub("***REDACTED***", text)
    return text


def collect_turn(transcript_path: Path) -> tuple[list, str | None, dict | None]:
    """
    Walk the transcript backwards to find messages since the last user prompt
    (not tool_result). Return (assistant_messages_in_turn, final_text,
    trigger_record) where trigger_record is the parsed turn-start record (used
    for threading).

    Turn boundaries we recognize (most recent wins):
      - type=user, content=str (normal CLI prompt or a channel message that
        arrived while we were idle)
      - type=user, content=list with text blocks and no tool_result
      - type=attachment with attachment.type=queued_command (channel inbound
        arrived MID-TURN while we were busy; queued as a separate attachment
        record, NOT a user message).
    """
    if not transcript_path.exists():
        return [], None, None
    lines = transcript_path.read_text().splitlines()
    turn_start = 0
    trigger: dict | None = None
    for i in range(len(lines) - 1, -1, -1):
        try:
            d = json.loads(lines[i])
        except Exception:
            continue
        rec_type = d.get("type")
        if rec_type == "attachment":
            att = d.get("attachment") or {}
            if att.get("type") == "queued_command":
                turn_start = i
                trigger = d
                break
            continue
        if rec_type != "user":
            continue
        msg = d.get("message") or {}
        content = msg.get("content")
        if isinstance(content, str):
            turn_start = i
            trigger = d
            break
        if isinstance(content, list):
            if not any(
                isinstance(b, dict) and b.get("type") == "tool_result"
                for b in content
            ):
                turn_start = i
                trigger = d
                break
    assistants = []
    for line in lines[turn_start:]:
        try:
            d = json.loads(line)
        except Exception:
            continue
        if d.get("type") == "assistant":
            assistants.append(d)
    if not assistants:
        return [], None, trigger
    # Final text = concatenated text blocks from the last assistant message.
    last = assistants[-1].get("message", {}).get("content") or []
    if not isinstance(last, list):
        return assistants, None, trigger
    parts = []
    for b in last:
        if isinstance(b, dict) and b.get("type") == "text":
            t = b.get("text") or ""
            if t.strip():
                parts.append(t)
    return assistants, ("\n\n".join(parts) if parts else None), trigger


def _msgid_from_text(text) -> str | None:
    """message_id from a <channel ...> opening tag at the START of text, else None."""
    if not isinstance(text, str):
        return None
    m = _CHANNEL_OPEN.match(text)
    if not m:
        return None
    mm = _MSGID.search(m.group(1))
    return mm.group(1) if mm else None


def latest_inbound_message_id(trigger: dict | None) -> str | None:
    """The inbound message_id that triggered this turn, parsed ONLY from the
    trigger record (never a free scan of the slice). None when terminal-typed."""
    if not isinstance(trigger, dict):
        return None
    t = trigger.get("type")
    if t == "user":
        c = (trigger.get("message") or {}).get("content")
        if isinstance(c, str):
            return _msgid_from_text(c)
    elif t == "attachment":
        att = trigger.get("attachment") or {}
        if att.get("type") == "queued_command":
            for k in ("prompt", "content", "text"):
                mid = _msgid_from_text(att.get(k))
                if mid:
                    return mid
    return None


def _last_blocks(assistants: list) -> list:
    if not assistants:
        return []
    c = assistants[-1].get("message", {}).get("content")
    if not isinstance(c, list):
        return []
    return [b.get("type") for b in c if isinstance(b, dict)]


def turn_settled(assistants: list, final_text: str | None) -> bool:
    """Has the final assistant message been fully written to the transcript?
    The Stop hook can fire mid-flush (thinking block on disk, text a beat later).
    A complete turn tails in a text block (final_text set) or a tool_use; a
    thinking-only tail means re-read."""
    if final_text:
        return True
    return "tool_use" in _last_blocks(assistants)


def turn_used_telegram(assistants: list) -> bool:
    for a in assistants:
        content = a.get("message", {}).get("content") or []
        if not isinstance(content, list):
            continue
        for b in content:
            if isinstance(b, dict) and b.get("type") == "tool_use":
                if b.get("name") in TELEGRAM_TOOL_NAMES:
                    return True
    return False


def looks_like_narration(text: str) -> bool:
    if len(text) < MIN_TEXT_LEN:
        return True
    stripped = text.strip()
    for pat in NARRATION_PATTERNS:
        if pat.search(stripped) and len(stripped) < 80:
            return True
    return False


def send_telegram(text: str, reply_to: str | None = None) -> tuple[bool, str]:
    """Delegate to `ezri-tg-send --markdown` so a mirrored reply is formatted
    identically to an intentional `reply`-tool send. reply_to threads it under
    the trigger message. Telegram is the #1 path → retry rc=1 up to 3x."""
    base = [TG_SEND, "--markdown", "--chat", CHAT_ID, "--text", text]
    if reply_to:
        base += ["--reply-to", reply_to]
    last = ""
    for attempt in range(3):
        if attempt:
            time.sleep(1.5 * attempt)  # 0, 1.5s, 3.0s
        try:
            p = subprocess.run(base, capture_output=True, text=True, timeout=30)
        except Exception as e:
            last = f"exception={e!r}"
            continue
        info = (p.stderr or "").strip().replace("\n", " ")[:160]
        if p.returncode == 0:
            return True, f"rc=0 attempt={attempt + 1} {info}"
        if p.returncode == 2:
            return False, f"rc=2 allowlist-refused {info}"  # don't retry
        last = f"rc={p.returncode} {info}"
    return False, f"{last} (after 3 attempts)"


def main() -> int:
    if os.environ.get("EZRI_TG_MIRROR") == "0":
        log("disabled by env")
        return 0

    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except Exception as e:
        log(f"bad stdin: {e}")
        return 0

    transcript_path = payload.get("transcript_path")
    if not transcript_path:
        log("no transcript_path in payload")
        return 0

    if EZRI_PROJECT_MARKER not in transcript_path:
        # Not an ezri-project session — silent skip (hook is Ezri-specific).
        return 0

    if channel_inactive():
        log("telegram channel inactive in this session — skip mirror")
        return 0

    if payload.get("stop_hook_active"):
        return 0  # prevent infinite re-entry

    assistants, final_text, trigger = collect_turn(Path(transcript_path))
    # Transcript-write race guard: re-read briefly if the turn isn't settled.
    waited = 0
    while not turn_settled(assistants, final_text) and waited < 6:
        time.sleep(0.3)
        waited += 1
        assistants, final_text, trigger = collect_turn(Path(transcript_path))
    if waited:
        log(f"transcript settle: re-read {waited}x, final_text={'yes' if final_text else 'no'}")

    if not assistants or not final_text:
        log("no final text in turn")
        return 0

    if turn_used_telegram(assistants):
        log("telegram tool already used in this turn — skip mirror")
        return 0

    if looks_like_narration(final_text):
        log(f"skipped narration: {final_text[:60]!r}")
        return 0

    token = load_token()
    if not token:
        log("no token loaded")
        return 0

    reply_to = latest_inbound_message_id(trigger)
    text = scrub(final_text)
    ok, info = send_telegram(text, reply_to)
    log(f"send ok={ok} reply_to={reply_to} {info} preview={text[:80]!r}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        log(f"FATAL {e!r}")
        sys.exit(0)
