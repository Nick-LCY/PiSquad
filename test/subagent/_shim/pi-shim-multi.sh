#!/usr/bin/env bash
# Configurable fake `pi` shim used by the arbitration e2e tests
# for multi-step (chain), multi-task (parallel), and
# multi-suspension scenarios.
#
# Behavior
# --------
# Environment knobs:
#   - SHIM_STEPS   : integer (default 1) — the shim emits this
#                    many distinct, named initial text events
#                    ("step 1", "step 2", …) so chain tests can
#                    observe per-step ordering. Each step's
#                    follow-up bash sleep is SHORT unless
#                    SHIM_LONG_SLEEP=1, which makes *this* step
#                    sleep long enough for the watchdog to
#                    freeze the process.
#   - SHIM_LONG_SLEEP : integer step index (1-based) that sleeps
#                    long enough to trip the watchdog. Default:
#                    no long sleep (every step exits cleanly).
#   - SHIM_SLEEP_S : seconds the *long* sleep lasts. Default 30.
#   - SHIM_QUIET_SLEEP_S : seconds a *short* sleep lasts.
#                    Default 1.
#   - SHIM_DEEP_TREE  : "1" to spawn a `setsid sleep` grandchild
#                    on the long-sleep step. The grandchild lives
#                    in its own process group + session, so the
#                    root pgid SIGSTOP only freezes the shim,
#                    NOT the grandchild (the C-bug/fix that
#                    motivated the per-pid descendant walk).
#                    The grandchild is reapable only via the
#                    descendant-walk fix in
#                    `suspensions.ts#collectDescendantPids`.
#                    When setsid is unavailable (e.g. busybox
#                    shim envs), the deep-tree setup is silently
#                    skipped and the shim only has one
#                    long-sleep fork — the test scenario detects
#                    the absence and reports `grandchildFrozen`
#                    as `skipped` in its result.
#
# Per-task freeze marker
# ----------------------
# The parent extension passes the task description as the LAST arg
# (`Task: <description>`). When the description contains the substring
# `FREEZE_ME`, this shim WILL run the long sleep on the
# SHIM_LONG_SLEEP step (and ONLY on that step). When the marker is
# absent, every step uses the short sleep — so the shim never
# trips the watchdog.
#
# This lets parallel scenarios pick one task out of N to freeze:
# siblings carry "task0_quiet" / "task2_quiet" in their description
# (no marker), the test subject carries "task1_FREEZE_ME" (matches
# the marker). All three tasks inherit the same SHIM_LONG_SLEEP
# env var from the parent; only the marked one actually freezes.
#
# Each step emits:
#   - one assistant text event ("step N: starting")
#   - one bash toolCall with the appropriate sleep
#   - on exit, one final assistant text event ("step N: finished")
#
# The shim writes its pid to the file $SHIM_PIDFILE (if set) so
# tests can verify the SAME proc survives across resume calls.
#
# NDJSON schema is identical to the simple shim (pi-shim.sh) so the
# parent's parser is exercised end-to-end.
set -u

exec 1> >(stdbuf -oL cat 2>/dev/null || cat)

if [ -n "${SHIM_PIDFILE:-}" ]; then
  echo "$$" > "$SHIM_PIDFILE"
fi

STEPS="${SHIM_STEPS:-1}"
LONG_SLEEP="${SHIM_LONG_SLEEP:-0}"
SLEEP_DUR="${SHIM_SLEEP_S:-30}"
QUIET_SLEEP_DUR="${SHIM_QUIET_SLEEP_S:-1}"
DEEP_TREE="${SHIM_DEEP_TREE:-0}"
# PID file for the setsid grandchild — written when SHIM_DEEP_TREE=1
# and `setsid` is available. The driver reads this back to verify
# which pid is the grandchild (so the test can probe its stat field).
GRANDCHILD_PIDFILE="${SHIM_GRANDCHILD_PIDFILE:-}"

# Per-task freeze marker. The parent passes `Task: <description>`
# as the trailing arg, but we test against the FULL `"$*"`
# string so a FREEZE_ME marker that lands in the middle of an
# arg (or an arbitrary position via shell quoting) still trips
# the watchdog. The previous design only looked at the LAST arg,
# which silently missed any task description containing the
# marker elsewhere in the args.
SHOULD_FREEZE=0
case "$*" in
  *FREEZE_ME*) SHOULD_FREEZE=1 ;;
esac

step_initial() {
  local n="$1"
  cat <<NDJSON
{"type":"message_end","message":{"role":"user","content":"ignored","timestamp":0}}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"starting shim"}],"model":"shim-model","api":"openai-responses","provider":"openai","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":{"total":0},"totalTokens":0},"stopReason":"stop","timestamp":1}}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"shim-tc-$n","name":"bash","arguments":{"command":"sleep ${LONG_SLEEP:+long}${QUIET_SLEEP_DUR}","timeout":900}}],"model":"shim-model","api":"openai-responses","provider":"openai","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":{"total":0},"totalTokens":0},"stopReason":"toolUse","timestamp":2}}
NDJSON
}

step_final() {
  local n="$1"
  cat <<NDJSON
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"step $n: finished"}],"model":"shim-model","api":"openai-responses","provider":"openai","usage":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"cost":{"total":0},"totalTokens":3},"stopReason":"stop","timestamp":3}}
{"type":"message_end","message":{"role":"toolResult","toolCallId":"shim-tc-$n","toolName":"bash","content":[{"type":"text","text":"slept"}],"isError":false,"timestamp":4}}
NDJSON
}

step_long_sleep_final() {
  local n="$1"
  cat <<NDJSON
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"step $n: resumed final output from shim"}],"model":"shim-model","api":"openai-responses","provider":"openai","usage":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"cost":{"total":0},"totalTokens":3},"stopReason":"stop","timestamp":3}}
{"type":"message_end","message":{"role":"toolResult","toolCallId":"shim-tc-$n","toolName":"bash","content":[{"type":"text","text":"slept"}],"isError":false,"timestamp":4}}
NDJSON
}

for n in $(seq 1 "$STEPS"); do
  step_initial "$n"
  if [ "$n" = "$LONG_SLEEP" ] && [ "$SHOULD_FREEZE" = "1" ]; then
    # Spawn a `setsid sleep` grandchild when requested. The grandchild
    # lives in its own pgid + sid, so a group-level SIGSTOP to the
    # shim's pgid will NOT reach it — which is exactly the bug the
    # deep-tree signal fix in suspensions.ts is meant to catch.
    if [ "$DEEP_TREE" = "1" ] && command -v setsid >/dev/null 2>&1; then
      # Detach from this shell's pgid so the grandchild has its own
      # session. The shim waits for the grandchild to finish before
      # exiting (so `wait` on the long-sleep step sees both the
      # plain `sleep` and the setsid grandchild).
      setsid sleep "$SLEEP_DUR" &
      GRANDCHILD_PID=$!
      if [ -n "$GRANDCHILD_PIDFILE" ]; then
        echo "$GRANDCHILD_PID" > "$GRANDCHILD_PIDFILE"
      fi
      sleep "$SLEEP_DUR"
      # Reap the grandchild if it's still alive at this point (the
      # kill scenario tears it down via SIGKILL before we reach here,
      # so the wait returns immediately).
      wait "$GRANDCHILD_PID" 2>/dev/null || true
    else
      sleep "$SLEEP_DUR"
    fi
    step_long_sleep_final "$n"
  else
    sleep "$QUIET_SLEEP_DUR"
    step_final "$n"
  fi
done

exit 0
