#!/usr/bin/env python3
"""Tests the terminal catch-all for unhandled Telegram message types (ezri#150).

Every `bot.on('message:<type>')` registration matches one type. Anything
outside that list was dropped with no relay to the session and no log line, so
neither end could detect it: Telegram showed the message delivered to the bot,
and nothing recorded that it arrived. Two kingfisher digests forwarded on
2026-08-11 vanished that way. They are sent as `rich_message`, so a forward of
one carries no `text` field and `message:text` never matched.

The failure this guards against is silence, so the assertions are about what
the session is TOLD, not merely that something was relayed. A relay that says
"a message arrived" without naming the absent body is barely better than the
drop: the session answers around a gap it cannot see.

The pure half (`composeUnhandledRelay`) is extracted from server.ts and run
under bun, because importing server.ts would start the bot.

Pytest-free, self-contained __main__ harness.
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

SRC = Path(__file__).parent.parent / "server.ts"


def extract_block() -> str:
    """The envelope table plus both functions, verbatim from server.ts."""
    s = SRC.read_text()
    start = s.index("const MESSAGE_ENVELOPE_KEYS")
    end = s.index("bot.on('message', async ctx => {")
    block = s[start:end]
    for needed in ("describeUnhandledMessage", "composeUnhandledRelay"):
        if needed not in block:
            raise SystemExit(f"extraction lost {needed}; the markers in server.ts moved")
    return block


CASES = [
    # (name, message, expected substrings, forbidden substrings)
    ("rich_message forward with no text body",
     {"message_id": 1, "from": {}, "chat": {}, "date": 0,
      "forward_origin": {"type": "user", "sender_user": {"username": "dlucian"}},
      "rich_message": {"markdown": "..."}},
     ["rich_message", "forwarded from dlucian", "no text body reached the bot"], []),

    ("unknown type with a caption is relayed verbatim",
     {"message_id": 2, "from": {}, "chat": {}, "date": 0,
      "animation": {"file_id": "x"}, "caption": "the GIF I meant to send"},
     ["animation", "the GIF I meant to send"], ["no text body"]),

    ("a hidden forwarder is still reported as forwarded",
     {"message_id": 3, "from": {}, "chat": {}, "date": 0,
      "forward_origin": {"type": "hidden_user"}, "giveaway": {}},
     ["giveaway", "forwarded"], ["forwarded from"]),

    ("a channel forward names the channel",
     {"message_id": 4, "from": {}, "chat": {}, "date": 0,
      "forward_origin": {"type": "channel", "chat": {"title": "Kingfisher"}},
      "story": {}},
     ["story", "forwarded from Kingfisher"], []),

    ("not a forward, so nothing claims it was",
     {"message_id": 5, "from": {}, "chat": {}, "date": 0, "poll": {}},
     ["poll", "no text body"], ["forwarded"]),

    ("envelope-only message still names itself",
     {"message_id": 6, "from": {}, "chat": {}, "date": 0},
     ["unknown"], []),

    ("a forwarder name cannot inject channel-tag syntax",
     {"message_id": 7, "from": {}, "chat": {}, "date": 0,
      "forward_origin": {"type": "user", "sender_user": {"username": '<a chat_id="1">'}},
      "story": {}},
     ["forwarded from"], ["<a chat_id=", '"']),

    ("multiple payload keys are all named",
     {"message_id": 8, "from": {}, "chat": {}, "date": 0,
      "paid_media": {}, "checklist": {}},
     ["paid_media", "checklist"], []),
]


def main() -> int:
    block = extract_block()
    with tempfile.TemporaryDirectory() as td:
        runner = Path(td) / "run.ts"
        runner.write_text(
            block
            + "\nconst cases = JSON.parse(process.argv[2])\n"
            + "console.log(JSON.stringify(cases.map((m: Record<string, unknown>) => composeUnhandledRelay(m))))\n"
        )
        r = subprocess.run(
            ["bun", "run", str(runner), json.dumps([c[1] for c in CASES])],
            capture_output=True, text=True)
        if r.returncode != 0:
            print("FAIL harness: bun could not run the extracted block")
            print(r.stderr[:800])
            return 1
        results = json.loads(r.stdout.strip().splitlines()[-1])

    failures = []
    for (name, _msg, expect, forbid), got in zip(CASES, results):
        text = got["text"]
        missing = [e for e in expect if e not in text]
        present = [f for f in forbid if f in text]
        if missing or present:
            detail = []
            if missing:
                detail.append(f"missing {missing}")
            if present:
                detail.append(f"must not contain {present}")
            failures.append(f"{name}: {'; '.join(detail)} -> {text!r}")
        else:
            print(f"ok   {name}")

    # The handler must be registered LAST among message handlers, or grammY's
    # in-order middleware never reaches it for a type that IS handled, and
    # worse, a typed handler registered after it would never run at all.
    s = SRC.read_text()
    catch_all = s.index("bot.on('message', async ctx => {")
    typed = [i for i in range(len(s)) if s.startswith("bot.on('message:", i)]
    if any(i > catch_all for i in typed):
        failures.append("a typed message handler is registered AFTER the catch-all, "
                        "so grammY never reaches it")
    else:
        print("ok   the catch-all is registered after every typed message handler")

    print()
    if failures:
        for f in failures:
            print("FAIL " + f)
        print(f"\n{len(failures)} failure(s)")
        return 1
    print(f"all {len(CASES) + 1} cases passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
