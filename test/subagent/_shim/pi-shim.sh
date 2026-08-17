#!/usr/bin/env bash
# Fake `pi` shim used by the arbitration e2e test.
#
# This script is NOT a real `pi`. It is dropped into a temp directory
# that is prepended to PATH, so when the subagent extension calls
# `spawn("pi", args)` it reaches us instead of the real binary.
#
# Behavior
# --------
# We simulate a sub-agent that emits a couple of NDJSON events, then
# sleeps for $SHIM_SLEEP_S seconds (default 10), then emits final
# events and exits 0. During the sleep, no events flow on stdout /
# stderr, so the parent watchdog freezes us with SIGSTOP. The tests
# then issue `resume` / `kill` commands and observe the response.
#
# We must be resilient to SIGSTOP/SIGCONT (kernel handles that) and
# to SIGKILL (no cleanup needed).
#
# NDJSON schema we emit
# ---------------------
# Each line is a `message_end` event with a single `AssistantMessage`.
# The schema mirrors what the real `pi --mode json` emits so the
# parent's parser is exercised end-to-end. We set `model` to a sentinel
# so tests can assert their messages came from us.

set -u

# Always flush stdout line-buffered so the parent parser sees partial
# output promptly (and our sleep below doesn't trap buffered data).
exec 1> >(stdbuf -oL cat 2>/dev/null || cat)

emit_initial_events() {
  cat <<'NDJSON'
{"type":"message_end","message":{"role":"user","content":"ignored","timestamp":0}}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"starting shim"}],"model":"shim-model","api":"openai-responses","provider":"openai","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":{"total":0},"totalTokens":0},"stopReason":"stop","timestamp":1}}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"shim-tc-1","name":"bash","arguments":{"command":"sleep 9999","timeout":900}}],"model":"shim-model","api":"openai-responses","provider":"openai","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":{"total":0},"totalTokens":0},"stopReason":"toolUse","timestamp":2}}
NDJSON
}

emit_final_events() {
  cat <<'NDJSON'
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"resumed final output from shim"}],"model":"shim-model","api":"openai-responses","provider":"openai","usage":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"cost":{"total":0},"totalTokens":3},"stopReason":"stop","timestamp":3}}
NDJSON
}

SLEEP_DUR="${SHIM_SLEEP_S:-10}"

emit_initial_events
# `sleep` honors SIGSTOP/SIGCONT at the kernel level. When the parent
# issues `process.kill(-pgid, "SIGSTOP")`, both this bash and our
# sleep child freeze together; SIGCONT resumes them.
sleep "$SLEEP_DUR"
emit_final_events

exit 0