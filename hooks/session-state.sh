#!/usr/bin/env bash
# claudegram session-state hook: record whether this session is busy or idle.
#
# The plugin (server.ts, via notif-queue.ts) reads the file this script writes
# and holds a channel message until the session is idle, so a message never
# folds into a running turn (dlucian/ezri#474). The marker is
#
#   $TELEGRAM_STATE_DIR/session-state/<claude_pid>      one word: busy or idle
#
# The file's mtime is the signal time. The plugin reads only its own claude
# ancestor's file, so another session can never mark this one busy or idle.
#
# Usage: session-state.sh <idle|busy|tool>
#   idle  SessionStart (startup, resume, clear), Stop, StopFailure, and the
#         Notification idle_prompt backstop for a turn that ended without Stop
#   busy  UserPromptSubmit
#   tool  PreToolUse. A main-thread call writes busy. A call with an agent_id
#         (a subagent) only refreshes the mtime, and only while the file says
#         busy, so a background subagent can't turn an idle session busy.
#
# Rules, as for ezri-typing-ping: no stdout, bounded work, exit 0 on every
# path. A missing state file means "deliver at once", so every failure here
# degrades to the old behavior and never strands a message.
#
# Gate: the file is written only when the detector says this session has the
# Telegram channel active (exit 0). Scheduled headless runs have no channel,
# so they leave no files. The detector prints the claude PID on stdout when it
# gets --print-pid. An older detector reads that flag as a PID and exits 2,
# which skips the write.

{
  action="${1:-}"
  case "$action" in idle | busy | tool) ;; *) exit 0 ;; esac

  detect="${CLAUDEGRAM_CHANNEL_DETECT:-$HOME/ezri/bin/ezri-tg-channel-active}"
  [ -x "$detect" ] || exit 0
  state_dir="${TELEGRAM_STATE_DIR:-$HOME/.claude/channels/telegram}"

  # A PreToolUse event carries the tool input, which can hold the text
  # "agent_id". Read the field with jq and never match a substring. Without a
  # working jq the event is treated as a subagent's: refresh only.
  main_thread=1
  if [ "$action" = tool ]; then
    main_thread=0
    if command -v jq >/dev/null 2>&1; then
      agent="$(head -c 8388608 | jq -r 'if type == "object" then (.agent_id // "") | tostring else "?" end' 2>/dev/null)" &&
        [ -z "$agent" ] && main_thread=1
    fi
  fi

  pid="$("$detect" --print-pid 2>/dev/null)" || exit 0
  case "$pid" in '' | *[!0-9]*) exit 0 ;; esac
  [ "$pid" -gt 1 ] 2>/dev/null || exit 0

  dir="$state_dir/session-state"
  mkdir -p -m 700 "$dir" 2>/dev/null || exit 0
  file="$dir/$pid"

  if [ "$action" = tool ] && [ "$main_thread" = 0 ]; then
    [ "$(head -c 16 "$file" 2>/dev/null)" = busy ] && touch "$file" 2>/dev/null
    exit 0
  fi

  case "$action" in idle) word=idle ;; *) word=busy ;; esac
  tmp="$dir/.$pid.$$.tmp"
  if printf '%s\n' "$word" >"$tmp" 2>/dev/null && mv -f "$tmp" "$file" 2>/dev/null; then
    :
  else
    rm -f "$tmp" 2>/dev/null
  fi
} >/dev/null 2>&1

exit 0
