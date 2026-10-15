#!/bin/bash
# Free-lane TOOL CALLING in the real TUI under tmux, with filesystem evidence.
# Composer lesson: long pasted prompts + Enter do not reliably submit; the
# launcher's first-turn argument (omp "<prompt>") and --continue drive turns
# deterministically INSIDE the tmux session.
#   turn 1: write + read   (omp "<prompt>")
#   turn 2: shell + read   (omp --continue "<prompt>")
#   turn 3: grep           (omp --continue "<prompt>")
# Hard failure on: Tool ... not found / Retry failed / 402 / member verdict.
set -u
MODEL="opencode-free/mimo-v2.6-flash-free"
WORK=/tmp/omp-tool-proof
rm -rf "$WORK"; mkdir -p "$WORK"
T=~/.omp/agent/omp-go-traffic.ndjson

fail() { echo "FAIL: $1" >&2; tail -25 /tmp/free-tools-pane.txt 2>/dev/null | grep -v "^ *$" >&2; exit 1; }
run_turn() { # run_turn <label> <marker> <args...>
  local label="$1" marker="$2"; shift 2
  local S="free-tools-$RANDOM"
  local before; before=$(wc -l < "$T")
  tmux kill-session -t "$S" 2>/dev/null
  tmux new-session -d -s "$S" -c /tmp -x 140 -y 42 "omp --model $MODEL $(printf '%q ' "$@")"
  local pane="" ok=0
  for _ in $(seq 1 48); do
    sleep 5
    pane="$(tmux capture-pane -t "$S" -p 2>/dev/null)"
    printf '%s' "$pane" > /tmp/free-tools-pane.txt
    if printf '%s' "$pane" | grep -qE "Tool [a-z_]+ not found|Retry failed|402 Upstream|member verdict|capacity exhausted|Provider requested"; then break; fi
    # Completion = the marker as a STANDALONE line (the transcript echo embeds
    # it in the prompt line and must never count) with the spinner gone.
    if ! printf '%s' "$pane" | grep -q "Working…"; then
      if printf '%s\n' "$pane" | grep -qE "^[[:space:]]*$marker[[:space:]]*$"; then ok=1; break; fi
    fi
  done
  tmux kill-session -t "$S" 2>/dev/null
  printf '%s' "$pane" | grep -qE "Tool [a-z_]+ not found|Retry failed|402 Upstream|member verdict" && fail "$label: tool/retry/account error on screen"
  local after; after=$(wc -l < "$T")
  echo "== [$label] ok=$ok traffic $before -> $after =="
  [ "$ok" = 1 ] || fail "$label: no completed reply"
}

echo "== turn 1: write + read =="
run_turn "T1" "ALPHA-117" "write ALPHA-117 to $WORK/a.txt with the write tool, then read it back and reply with only that line"
grep -qx "ALPHA-117" "$WORK/a.txt" 2>/dev/null || fail "T1: write tool produced no file"
grep -q "ALPHA-117" /tmp/free-tools-pane.txt || fail "T1: reply did not surface the file content"
echo "ok  T1: write+read verified on disk and on screen"

echo "== turn 2: shell + read (continued session) =="
run_turn "T2" "BRAVO-228" --continue "run: echo BRAVO-228 > $WORK/b.txt using the shell tool, then reply with only: BRAVO-228"
grep -qx "BRAVO-228" "$WORK/b.txt" 2>/dev/null || fail "T2: shell tool produced no file"
echo "ok  T2: shell+read verified on disk"

echo "== turn 3: grep (continued session) =="
run_turn "T3" "b.txt" --continue "grep $WORK for BRAVO-228 and reply with only the matching file path"
grep -q "b.txt" /tmp/free-tools-pane.txt || fail "T3: reply did not name the grep match"
echo "ok  T3: grep verified"

echo "TMUX FREE TOOLS OK: 3 turns (write/read/shell/grep) with filesystem evidence"
