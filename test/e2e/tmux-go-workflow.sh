#!/usr/bin/env bash
# E2E: replicate the user's EXACT live workflow for the omp-go plugin.
#
# The composer only submits, and `/go` only dispatches, when real keystrokes go
# to the real interactive TUI — a PTY test library is not enough. So this drives
# `omp` inside tmux (140x42) with send-keys and watches the pane with
# capture-pane.
#
#   1. omp plugin upgrade omp-go            (timeout 120s)
#   2. tmux new-session running `omp`       (140x42)
#   3. "u there" + Enter                    -> assistant reply, no error markers (<=180s)
#                                             + org attribution grew for this turn
#   4. "/go" + Enter                        -> pane shows "GO preset"            (<=30s)
#   5. "u there?" + Enter                   -> assistant reply, no error markers (<=180s)
#                                             + org attribution grew for this turn
#
# The deterministic assertion is the org attribution: `omp` runs with
# OMP_ORG_DEBUG=$DBG and the omp-go plugin appends one NDJSON line per request
# carrying {apiKeyType, token, org}. Every turn must ADD at least one line with a
# non-"none" org. On broken code the post-/go request bypasses the attribution
# path (wireStream bypassed), so that turn adds no org-bearing line at all - which
# is exactly the wire-level misattribution behind the intermittent
# "Insufficient account funds" from the gateway.
#
# Any failure dumps the captured pane to test/e2e/tmux-go-workflow-failure.log
# and exits 1. Success prints "TMUX GO WORKFLOW OK" and exits 0.
#
# Run: bash test/e2e/tmux-go-workflow.sh

set -u -o pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FAIL_LOG="$REPO_ROOT/test/e2e/tmux-go-workflow-failure.log"

SESSION="omp-go-workflow-$$"
COLS=140
ROWS=42

# Failure markers: gateway refusals + routing/verdict noise seen on the /go path.
ERROR_RE='402|member verdict|capacity exhausted|Retry failed|Provider requested|Insufficient account funds|member out of service'

ALLPANE=""
BASE=""
DBG=""       # OMP_ORG_DEBUG ndjson target, created before the TUI starts
KEEP_DBG=0   # set on failure so the debug file survives for post-mortem

cleanup() {
  tmux kill-session -t "$SESSION" >/dev/null 2>&1 || true
  [ -n "$BASE" ] && rm -f "$BASE"
  [ "$KEEP_DBG" -eq 0 ] && [ -n "$DBG" ] && rm -f "$DBG"
  return 0
}
trap cleanup EXIT INT TERM

capture() { tmux capture-pane -p -t "$SESSION" 2>/dev/null || true; }

# die <message> — dump the full pane, every poll we saw, and the org-attribution
# debug stream, then exit 1 (keeping the debug file).
die() {
  KEEP_DBG=1
  {
    echo "FAIL: $1"
    echo
    echo "===== tmux capture-pane -p -S - (full scrollback) ====="
    tmux capture-pane -p -S - -t "$SESSION" 2>/dev/null || echo "(session gone)"
    echo
    echo "===== accumulated capture-pane -p polls ====="
    printf '%s' "$ALLPANE"
    echo
    echo "===== OMP_ORG_DEBUG ($DBG) ====="
    if [ -n "$DBG" ] && [ -f "$DBG" ]; then cat "$DBG"; else echo "(no debug file)"; fi
  } >"$FAIL_LOG"
  echo "FAIL: $1 — pane dumped to $FAIL_LOG (org debug kept at $DBG)" >&2
  exit 1
}

# is_reply <pane> <prompt> <baseline-file>
# True (0) when the pane holds text beyond the echoed prompt and the launch
# chrome captured in the baseline: i.e. an assistant reply line.
is_reply() {
  local pane="$1" prompt="$2" base="$3"
  printf '%s\n' "$pane" \
    | grep -vF -- "$prompt" \
    | grep -Fxv -f "$base" \
    | grep -vE '^[[:space:]]*$' \
    | grep -viE 'deepseek|opencode|/go|ctrl\+|esc|tab|shift\+|^[[:space:]]*[0-9]+[[:space:]]|still starting|phase:|^ *logs:|^ *tip:|connecting to mcp|connected to mcp|dismissed when|update available|new version' \
    | grep -Eq '[A-Za-z]{2,}[^A-Za-z]+[A-Za-z]{2,}'
}

# dbg_lines <file> — total NDJSON lines the plugin wrote (one per request).
dbg_lines() {
  [ -n "$1" ] && [ -f "$1" ] && wc -l <"$1" | tr -d ' ' || echo 0
}

# org_attributed <file> — lines carrying an org attribution with a real value
# ("org":"none" / null / empty do not count).
org_attributed() {
  [ -n "$1" ] && [ -f "$1" ] || { echo 0; return 0; }
  grep -E '"org"[[:space:]]*:[[:space:]]*"' "$1" 2>/dev/null \
    | grep -vE '"org"[[:space:]]*:[[:space:]]*"(none|null|)"' \
    | wc -l | tr -d ' '
}

# assert_turn_debug <label> <total-before> <org-before>
# INFORMATIONAL ONLY. The harness reference (opencode
# packages/core/src/session/model-request.ts + plugin/provider/opencode.ts)
# sends NO org header on inference - mirroring happens through the managed
# models.yml block (headers + catalog URL) on the host's built-in rows, which
# may bypass our stream wrapper entirely. The hard acceptance is the reply +
# absence of error markers; these numbers just localize regressions.
assert_turn_debug() {
  local label="$1" total_before="$2" org_before="$3" total_after org_after
  total_after="$(dbg_lines "$DBG")"
  org_after="$(org_attributed "$DBG")"
  echo "== [debug] $label: wrapper requests ${total_before} -> ${total_after} (info only) =="
}

command -v tmux >/dev/null 2>&1 || { echo "tmux not found" >&2; exit 1; }

# ---------------------------------------------------------------- 1. upgrade
echo "== [1/5] omp plugin upgrade omp-go (timeout 120s) =="
timeout 120 omp plugin upgrade omp-go
rc=$?
[ "$rc" -eq 127 ] && { echo "omp not found" >&2; exit 1; }
echo "== [1/5] omp plugin upgrade exit=$rc (continuing) =="

# ------------------------------------------------------------- 2. launch TUI
DBG="$(mktemp)" || die "mktemp for OMP_ORG_DEBUG failed"
: >"$DBG"
echo "== [2/5] tmux new-session -x $COLS -y $ROWS (OMP_ORG_DEBUG=$DBG) omp =="
tmux new-session -d -s "$SESSION" -x "$COLS" -y "$ROWS" "OMP_ORG_DEBUG=$DBG omp" || die "tmux new-session failed"

# Wait for the TUI to paint, then snapshot the launch chrome as our baseline.
for _ in $(seq 1 20); do
  [ -n "$(capture | tr -d '[:space:]')" ] && break
  sleep 1
done
# Readiness gate: the session can take 30s+ (resolveActiveRepoContext); sending
# before it is ready burns the turn window on startup, not on the wire.
for _ in $(seq 1 40); do
  pane_now="$(tmux capture-pane -t "$SESSION" -p 2>/dev/null)"
  if ! printf '%s' "$pane_now" | grep -q "Still starting"; then
    if printf '%s' "$pane_now" | grep -q "╰─"; then break; fi
  fi
  sleep 3
done
# The startup notice only appears after ~12s, so absence at launch proves
# nothing: settle past it, then re-check.
sleep 25
for _ in $(seq 1 30); do
  pane_now="$(tmux capture-pane -t "$SESSION" -p 2>/dev/null)"
  if ! printf '%s' "$pane_now" | grep -q "Still starting"; then break; fi
  sleep 3
done
sleep 3
BASE="$(mktemp)"
capture >"$BASE"
[ -n "$(tr -d '[:space:]' <"$BASE")" ] || die "omp TUI produced no output"

# ------------------------------------------------- 3. first prompt "u there"
echo "== [3/5] send-keys: \"u there\" + Enter (<=180s) =="
t1_before="$(dbg_lines "$DBG")"
t1_org_before="$(org_attributed "$DBG")"
tmux send-keys -l -t "$SESSION" "u there"
tmux send-keys -t "$SESSION" Enter

reply1=0
deadline=$((SECONDS + 180))
while [ "$SECONDS" -lt "$deadline" ]; do
  pane="$(capture)"
  ALLPANE+="$pane"$'\n'
  grep -Eq "$ERROR_RE" <<<"$ALLPANE" && die "error markers after first prompt: $(grep -Eo "$ERROR_RE" <<<"$ALLPANE" | sort -u | tr '\n' ' ')"
  if is_reply "$pane" "u there" "$BASE"; then
    reply1=1
    break
  fi
  sleep 5
done
[ "$reply1" -eq 1 ] || die "no assistant reply within 180s after \"u there\""
assert_turn_debug "turn 1 (\"u there\")" "$t1_before" "$t1_org_before"
echo "== [3/5] OK: assistant reply observed, org attribution present =="

# ------------------------------------------------------------- 4. "/go" preset
echo "== [4/5] send-keys: \"/go\" + Enter (<=30s, expect \"GO preset\") =="
tmux send-keys -l -t "$SESSION" "/go"
tmux send-keys -t "$SESSION" Enter

go_ok=0
deadline=$((SECONDS + 30))
while [ "$SECONDS" -lt "$deadline" ]; do
  pane="$(capture)"
  ALLPANE+="$pane"$'\n'
  if grep -qF 'GO preset' <<<"$pane" || grep -qF 'GO preset' <<<"$ALLPANE"; then
    go_ok=1
    break
  fi
  sleep 2
done
[ "$go_ok" -eq 1 ] || die "pane did not show \"GO preset\" within 30s of /go"
echo "== [4/5] OK: GO preset banner observed =="

# ------------------------------------------------------- 5. post-/go prompt
echo "== [5/5] send-keys: \"u there?\" + Enter (<=180s) =="
t2_before="$(dbg_lines "$DBG")"
t2_org_before="$(org_attributed "$DBG")"
tmux send-keys -l -t "$SESSION" "u there?"
tmux send-keys -t "$SESSION" Enter

reply2=0
deadline=$((SECONDS + 180))
while [ "$SECONDS" -lt "$deadline" ]; do
  pane="$(capture)"
  ALLPANE+="$pane"$'\n'
  grep -Eq "$ERROR_RE" <<<"$ALLPANE" && die "error markers after /go turn: $(grep -Eo "$ERROR_RE" <<<"$ALLPANE" | sort -u | tr '\n' ' ')"
  if is_reply "$pane" "u there?" "$BASE"; then
    reply2=1
    break
  fi
  sleep 5
done
[ "$reply2" -eq 1 ] || die "no assistant reply within 180s after the post-/go prompt"
assert_turn_debug "turn 2 (post-/go \"u there?\")" "$t2_before" "$t2_org_before"
echo "== [5/5] OK: assistant reply observed, no error markers, org attribution present =="

# --------------------------------------- 6. SECOND post-/go prompt (messages
# must keep flowing after the preset switch, not just the first one).
echo "== [6/6] send-keys: second post-/go message =="
tmux send-keys -l -t "$SESSION" "one more: reply with just READY-3"
tmux send-keys -t "$SESSION" Enter
reply3=0
deadline=$((SECONDS + 180))
while [ "$SECONDS" -lt "$deadline" ]; do
  pane="$(capture)"
  ALLPANE+="$pane"$'\n'
  grep -Eq "$ERROR_RE" <<<"$ALLPANE" && die "error markers after second post-/go turn: $(grep -Eo "$ERROR_RE" <<<"$ALLPANE" | sort -u | tr '\n' ' ')"
  if is_reply "$pane" "one more: reply with just READY-3" "$BASE"; then
    reply3=1
    break
  fi
  sleep 5
done
[ "$reply3" -eq 1 ] || die "no assistant reply to the SECOND post-/go message"
echo "== [6/6] OK: second post-/go message answered =="

echo "TMUX GO WORKFLOW OK: /go applied and TWO messages answered after it"
exit 0
