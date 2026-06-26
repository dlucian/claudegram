#!/usr/bin/env python3
"""Tests for the claudegram Stop hook (dlucian/ezri#80, auto-send fold).

Focus on the deterministic decision + threading logic the adversarial review
flagged: anchored message_id extraction (immune to stale ids in the slice),
the queued_command mid-turn path (id lives in attachment.prompt), turn-boundary
detection, the double-send carve-out, narration filter, and secret scrub. The
actual Bot API send (delegated to ezri-tg-send) is not exercised here.

Pytest-free, self-contained __main__ harness.
"""
from __future__ import annotations

import json
import sys
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path

HOOK = Path(__file__).parent.parent / "hooks" / "stop-mirror.py"
m = SourceFileLoader("stop_mirror", str(HOOK)).load_module()


def _write_transcript(tmp_path: Path, records: list[dict]) -> Path:
    p = tmp_path / "session.jsonl"
    p.write_text("\n".join(json.dumps(r) for r in records) + "\n")
    return p


def _user_str(text: str) -> dict:
    return {"type": "user", "message": {"role": "user", "content": text}}


def _user_toolresult(tid: str) -> dict:
    return {"type": "user", "message": {"role": "user",
            "content": [{"tool_use_id": tid, "type": "tool_result", "content": "ok"}]}}


def _assistant_text(text: str) -> dict:
    return {"type": "assistant", "message": {"role": "assistant",
            "content": [{"type": "text", "text": text}]}}


def _assistant_tool(name: str) -> dict:
    return {"type": "assistant", "message": {"role": "assistant",
            "content": [{"type": "tool_use", "id": "t1", "name": name, "input": {}}]}}


def _channel(mid: str, kind: str = "") -> str:
    extra = f' kind="{kind}"' if kind else ""
    return (f'<channel source="plugin:telegram:telegram" chat_id="36632230" '
            f'message_id="{mid}" user="dlucian"{extra}>\nhello there\n</channel>')


# ── anchored message_id extraction ──────────────────────────────────────────

def test_msgid_anchored_basic_and_escaped():
    assert m._msgid_from_text(_channel("4908")) == "4908"
    # ask_answer taps arrive the same way (user string, channel block at start)
    assert m._msgid_from_text(_channel("4660", kind="ask_answer")) == "4660"
    # HTML-escaped channel tag (seen in some injected records) still parses
    assert m._msgid_from_text('&lt;channel message_id="4671"&gt;\ntapped') == "4671"


def test_msgid_rejects_stale_id_not_at_start():
    # A message_id that appears mid-text (e.g. a recalled-memory block) must NOT
    # be picked — only the opening <channel ...> tag counts.
    assert m._msgid_from_text('preamble ... message_id="3906" buried later') is None
    assert m._msgid_from_text("just a terminal prompt, no channel") is None
    assert m._msgid_from_text(None) is None
    # a channel tag at the start wins even if a stale id trails it
    poisoned = _channel("4908") + '\n...recalled: message_id="3906"...'
    assert m._msgid_from_text(poisoned) == "4908"


# ── collect_turn + latest_inbound_message_id ────────────────────────────────

def test_user_string_inbound_threads(tmp_path):
    tp = _write_transcript(tmp_path, [
        _user_str(_channel("4908")),
        _assistant_text("here is my reply"),
    ])
    assistants, final_text, trigger = m.collect_turn(tp)
    assert final_text == "here is my reply"
    assert m.latest_inbound_message_id(trigger) == "4908"


def test_queued_command_midturn_threads_from_prompt(tmp_path):
    # A message that arrived MID-TURN is queued as an attachment whose channel
    # block lives in attachment.prompt — the main reason threading exists.
    tp = _write_transcript(tmp_path, [
        _user_str(_channel("100")),          # earlier turn boundary
        _assistant_tool("Bash"),
        {"type": "attachment", "attachment": {"type": "queued_command",
                                              "prompt": _channel("5000")}},
        _assistant_text("done"),
    ])
    assistants, final_text, trigger = m.collect_turn(tp)
    assert final_text == "done"
    assert m.latest_inbound_message_id(trigger) == "5000"


def test_poisoned_hook_context_does_not_steal_threading(tmp_path):
    # The trigger is a clean inbound (4908). A later hook_additional_context
    # attachment embeds a STALE channel block (3906). Threading must stay 4908.
    tp = _write_transcript(tmp_path, [
        _user_str(_channel("4908")),
        {"type": "attachment", "attachment": {"type": "hook_additional_context",
            "content": f'recalled memory {_channel("3906")}'}},
        _assistant_text("my answer"),
    ])
    assistants, final_text, trigger = m.collect_turn(tp)
    assert m.latest_inbound_message_id(trigger) == "4908"
    assert final_text == "my answer"


def test_terminal_typed_turn_no_thread(tmp_path):
    tp = _write_transcript(tmp_path, [
        _user_str("just run the tests please"),
        _assistant_text("on it, running them now for you"),
    ])
    _, _, trigger = m.collect_turn(tp)
    assert m.latest_inbound_message_id(trigger) is None


def test_collect_turn_ignores_prior_turn_toolresults(tmp_path):
    tp = _write_transcript(tmp_path, [
        _user_str(_channel("7000")),
        _assistant_tool("Bash"),
        _user_toolresult("t1"),          # NOT a turn boundary
        _assistant_text("final answer here"),
    ])
    assistants, final_text, trigger = m.collect_turn(tp)
    assert m.latest_inbound_message_id(trigger) == "7000"
    assert final_text == "final answer here"


# ── carve-outs ──────────────────────────────────────────────────────────────

def test_double_send_guard():
    used = [_assistant_tool("mcp__plugin_telegram_telegram__reply"),
            _assistant_text("x")]
    assert m.turn_used_telegram(used) is True
    not_used = [_assistant_tool("Bash"), _assistant_text("x")]
    assert m.turn_used_telegram(not_used) is False


def test_turn_settled():
    thinking_only = [{"type": "assistant", "message": {"content": [{"type": "thinking", "thinking": "..."}]}}]
    assert m.turn_settled(thinking_only, None) is False
    assert m.turn_settled(thinking_only, "real text") is True
    has_tool = [_assistant_tool("Bash")]
    assert m.turn_settled(has_tool, None) is True


def test_narration_and_short_skip():
    assert m.looks_like_narration("Running the suite") is True
    assert m.looks_like_narration("short") is True            # < 12 chars
    assert m.looks_like_narration("Here is the finished plan, ready for your review") is False


def test_secret_scrub():
    body = "token ghp_" + "a" * 30 + " and a key AKIA" + "B" * 16
    out = m.scrub(body)
    assert "ghp_" not in out and "AKIA" not in out
    assert "***REDACTED***" in out


if __name__ == "__main__":
    import inspect
    import traceback

    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = failed = 0
    for fn in tests:
        try:
            if "tmp_path" in inspect.signature(fn).parameters:
                with tempfile.TemporaryDirectory() as td:
                    fn(tmp_path=Path(td))
            else:
                fn()
            print(f"  ok  {fn.__name__}")
            passed += 1
        except Exception:
            print(f" FAIL {fn.__name__}")
            traceback.print_exc()
            failed += 1
    print(f"\n{passed} passed, {failed} failed")
    sys.exit(0 if failed == 0 else 1)
