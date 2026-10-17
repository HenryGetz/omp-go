#!/bin/bash
# Free-lane TOOL-CALLING MATRIX: every live free model, one turn each, real
# multi-parameter probes on both protocol lanes, filesystem + ledger evidence.
#
# Roster is derived at RUNTIME through the plugin's own fetchFreeModels
# (src/models.ts) — the free roster rotates upstream and is never hardcoded.
# The lane comes from usesResponsesAPI (provider.npm === "@ai-sdk/openai").
#
# Per model (ONE chat turn, fresh tmux session, fresh cwd):
#   forced probes — todo (non-offered, op/init/list shape), task (non-offered,
#   context/tasks shape), glob (offered control, pattern/path shape).
# Assertions from the session JSONL (analyzer written to $WORK once):
#   - every toolCall carries schema-complete arguments (no __parseError, no
#     empty {}, no "(was missing)"/"Invalid" validation results),
#   - traffic rows for the model reached status 200 in the ledger.
# Result classes:
#   PASS / MODEL-PROBES (calls complete but a forced probe wasn't attempted —
#   model behavior, documented not fatal) / FAIL (schema-incomplete calls, no
#   calls at all, or no 200) / SKIP-NOTOOL (catalog tool_call false — the
#   documented expected-skip) / SKIP-LIMITED (429 window) /
#   STOP-403 (workspace-capacity verdict: the run halts immediately).
#
# Panes + per-model verbatim toolCall evidence land in /tmp/omp-tool-matrix/;
# every tmux session this script creates is killed; non-zero exit on FAIL or
# STOP-403.
#
# Run: bash test/e2e/tmux-tool-matrix.sh [model-id ...]
# With model arguments, only those models run (targeted re-runs); the roster
# is still derived live and any named model absent from it is skipped.

set -u -o pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK=/tmp/omp-tool-matrix
T="$HOME/.omp/agent/omp-go-traffic.ndjson"
MARKER="MATRIX-DONE"
PROMPT="Run these three tool calls in this order, then reply with only $MARKER: 1) the todo tool with op init to create a list named matrix containing items matrix-alpha and matrix-beta; 2) the task tool with context 'tool matrix probe' and exactly one task asking the subagent to reply with only OK; 3) the glob tool with pattern *.md and path /tmp. Do not skip any of the three calls."

rm -rf "$WORK"; mkdir -p "$WORK"
command -v tmux >/dev/null 2>&1 || { echo "tmux not found" >&2; exit 1; }
command -v omp >/dev/null 2>&1 || { echo "omp not found" >&2; exit 1; }

SESSIONS=()
cleanup() {
  local s
  for s in "${SESSIONS[@]:-}"; do tmux kill-session -t "$s" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM

# ------------------------------------------------ session-JSONL analyzer
cat > "$WORK/analyze-session.py" <<'PY'
import json, sys

# Pair every toolCall with its toolResult (by toolCallId). A call is BAD when
#   - its arguments carry __parseError (unparseable / lost-args marker),
#   - its ERRORED result failed schema validation ("(was missing)" /
#     "Invalid" / "Validation failed"). Markers only count when isError=true:
#     host validation failures always arrive errored; a successful result
#     whose TEXT quotes those words (file reads, script output) is content,
#     not a schema failure.
#   - it arrived with EMPTY arguments AND its result errored (empty {} against
#     an all-optional tool like `wait` that SUCCEEDS is schema-complete).
calls, bad, bad_results = [], False, []
VALIDATION_MARKERS = ("(was missing)", "__parseError", "Invalid", "Validation failed")
results = {}

for line in open(sys.argv[1]):
    line = line.strip()
    if not line:
        continue
    try:
        obj = json.loads(line)
    except Exception:
        continue
    msg = obj.get("message") or {}
    role = msg.get("role")
    if role == "toolResult":
        blob = json.dumps(msg.get("content") or [])
        results[msg.get("toolCallId")] = (bool(msg.get("isError")), blob)

for line in open(sys.argv[1]):
    line = line.strip()
    if not line:
        continue
    try:
        obj = json.loads(line)
    except Exception:
        continue
    msg = obj.get("message") or {}
    if msg.get("role") != "assistant":
        continue
    for part in (msg.get("content") or []):
        if not isinstance(part, dict) or part.get("type") != "toolCall":
            continue
        name, args, cid = part.get("name", "?"), part.get("arguments"), part.get("id")
        is_err, blob = results.get(cid, (False, ""))
        if "__parseError" in json.dumps(args):
            bad = True
            calls.append((name, json.dumps(args, sort_keys=True), "PARSE-ERR"))
            continue
        if is_err and any(m in blob for m in VALIDATION_MARKERS):
            bad = True
            bad_results.append(blob[:160])
            calls.append((name, json.dumps(args, sort_keys=True) if args else "{}", "INVALID"))
            continue
        if not isinstance(args, dict) or not args:
            if is_err:
                bad = True
                calls.append((name, "{}", "EMPTY-ERR"))
            else:
                calls.append((name, "{}", "empty-ok"))
            continue
        calls.append((name, json.dumps(args, sort_keys=True), "ok"))

names = sorted({c[0] for c in calls})
print(json.dumps({
    "bad": bad,
    "count": len(calls),
    "names": names,
    "calls": calls[:12],
    "bad_results": bad_results[:3],
}))
PY

# ------------------------------------------------------- runtime roster
echo "== deriving live free roster via the plugin's own fetchFreeModels =="
ROSTER="$(cd "$REPO_ROOT" && bun -e '
import { fetchFreeModels, usesResponsesAPI, CATALOG_URL } from "./src/models.ts"
const models = await fetchFreeModels({ session: { session: "omp-tool-matrix", affinity: "", project: "", client: "omp-tool-matrix" } })
let toolCall = {}
try {
  const payload = await (await fetch(CATALOG_URL)).json()
  const entry = payload["opencode"]
  for (const [id, model] of Object.entries(entry?.models ?? {})) toolCall[id] = model.tool_call !== false
} catch {}
for (const model of models) console.log(`${model.id}\t${usesResponsesAPI(model.id) ? "responses" : "chat"}\t${toolCall[model.id] === false ? "false" : "true"}`)
' 2>/dev/null)"
[ -n "$ROSTER" ] || { echo "FAIL: roster derivation returned nothing" >&2; exit 1; }
echo "$ROSTER" | awk -F'\t' '{printf "  %-36s %-9s tool_call=%s\n", $1, $2, $3}'

# Optional filter: run only the named models (still live-roster-validated).
if [ "$#" -gt 0 ]; then
  FILTER=" $* "
  ROSTER="$(echo "$ROSTER" | while IFS=$'\t' read -r id lane tc; do case "$FILTER" in *" $id "*) printf '%s\t%s\t%s\n' "$id" "$lane" "$tc";; esac; done)"
  [ -n "$ROSTER" ] || { echo "FAIL: none of the named models are in the live roster" >&2; exit 1; }
  echo "== filtered to: $(echo "$ROSTER" | cut -f1 | tr '\n' ' ') =="
fi

# Least-used first (healthiest windows burn first, riskiest last), derived from
# this machine's own ledger; unknown models sort as 0.
usage_count() {
  [ -f "$T" ] || { echo 0; return; }
  local n
  n=$(grep -c "\"model\":\"$1\"" "$T" 2>/dev/null)
  echo "${n:-0}"
}
ORDERED="$(echo "$ROSTER" | while IFS=$'\t' read -r id lane tc; do printf '%08d\t%s\t%s\t%s\n' "$(usage_count "$id")" "$id" "$lane" "$tc"; done | sort -n)"

# ------------------------------------------------------- per-model runner
RESULTS=()
STOP403=0

run_model() {
  local id="$1" lane="$2" tc="$3"
  local S="omp-matrix-$$-${id//[^a-zA-Z0-9_-]/-}"
  local DIR="$WORK/$id"; mkdir -p "$DIR"
  local pane="$DIR.pane.txt"
  local before_lines=0 after_lines=0
  [ -f "$T" ] && before_lines=$(wc -l < "$T")

  if [ "$tc" = "false" ]; then
    RESULTS+=("$id|$lane|SKIP-NOTOOL|catalog tool_call=false")
    echo "-- [$id] SKIP-NOTOOL (catalog tool_call=false)"
    return 0
  fi

  echo "-- [$id] lane=$lane launching one turn ($MARKER)"
  # BEFORE launch: the JSONL discovery keys on mtime newer than this stamp.
  local start_ts; start_ts=$(date -u +%Y-%m-%dT%H:%M:%S.%N 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)
  tmux kill-session -t "$S" 2>/dev/null
  tmux new-session -d -s "$S" -c "$DIR" -x 170 -y 44 "omp --model opencode-free/$id $(printf '%q ' "$PROMPT")"
  SESSIONS+=("$S")

  local ok=0 stopped=0
  local pane_now=""
  for _ in $(seq 1 180); do
    sleep 5
    pane_now="$(tmux capture-pane -t "$S" -p 2>/dev/null)"
    printf '%s' "$pane_now" > "$pane"
    if printf '%s' "$pane_now" | grep -q "workspace capacity rejected"; then stopped=1; break; fi
    if ! printf '%s' "$pane_now" | grep -q "Working…"; then
      if printf '%s\n' "$pane_now" | grep -qE "^[[:space:]]*$MARKER[[:space:]]*$"; then ok=1; break; fi
      # Turn ended without the marker: stop waiting, assertions decide.
      if printf '%s' "$pane_now" | grep -qE "Tool [a-zA-Z_0-9]+ not found|Retry failed|Provider requested|capacity exhausted|FreeUsageLimit"; then break; fi
    fi
  done
  printf '%s' "$pane_now" > "$pane"
  tmux kill-session -t "$S" 2>/dev/null
  [ -f "$T" ] && after_lines=$(wc -l < "$T")

  if [ "$stopped" = 1 ]; then
    RESULTS+=("$id|$lane|STOP-403|workspace capacity rejected this account")
    STOP403=1
    echo "STOP-403 on $id — halting the matrix (do not retry)"
    return 1
  fi

  # Traffic evidence: new ledger rows for this model.
  local statuses=""
  if [ -f "$T" ] && [ "$after_lines" -gt "$before_lines" ]; then
    statuses=$(tail -n $((after_lines - before_lines)) "$T" | grep "\"model\":\"$id\"" | grep -oE '"status":[0-9]+' | sort | uniq -c | tr -s ' ' | tr '\n' ' ')
  fi
  if printf '%s' "$statuses" | grep -q '429'; then
    RESULTS+=("$id|$lane|SKIP-LIMITED|429 window; traffic: ${statuses:-none}")
    echo "-- [$id] SKIP-LIMITED (429); traffic: ${statuses:-none}"
    return 0
  fi

  # Session JSONL: the OLDEST session file newer than start_ts in this turn's
  # cwd-slug dir. The parent (probe) session is created first; a `task`
  # subagent inherits the cwd and writes a NEWER sibling file that must not
  # be analyzed (its results quote arbitrary repo text).
  local slug jsonl
  slug=$(printf '%s' "$DIR" | sed 's|/|-|g')
  jsonl=$(find "$HOME/.omp/agent/sessions/$slug" -maxdepth 1 -name '*.jsonl' -newermt "$start_ts" 2>/dev/null | sort | head -1)
  # Belt and braces: the parent's FIRST user message carries the marker.
  if [ -n "$jsonl" ] && ! head -c 4096 "$jsonl" | grep -q "$MARKER"; then
    local candidate
    for candidate in $(find "$HOME/.omp/agent/sessions/$slug" -maxdepth 1 -name '*.jsonl' -newermt "$start_ts" 2>/dev/null | sort); do
      if head -c 4096 "$candidate" | grep -q "Run these three tool calls"; then jsonl="$candidate"; break; fi
    done
  fi

  local verdict evidence
  if [ -z "$jsonl" ]; then
    verdict=FAIL; evidence="no session JSONL; ok_marker=$ok; traffic: ${statuses:-none}"
  else
    local parsed bad count names
    parsed=$(python3 "$WORK/analyze-session.py" "$jsonl")
    bad=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["bad"])' "$parsed")
    count=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["count"])' "$parsed")
    names=$(python3 -c 'import json,sys; print(",".join(json.loads(sys.argv[1])["names"]))' "$parsed")
    # Verbatim toolCall args (+ any validation failures) as evidence.
    python3 -c '
import json, sys
data = json.loads(sys.argv[1])
print("session:", sys.argv[2])
for name, args, state in data["calls"]:
    print(f"  toolCall {name} [{state}]: {args}")
for blob in data["bad_results"]:
    print(f"  BAD-RESULT: {blob}")
' "$parsed" "$jsonl" >> "$WORK/$id.evidence.txt"
    if [ "$bad" = "True" ] || [ "$count" = "0" ]; then
      verdict=FAIL
      evidence="schema-incomplete=$bad calls=$count probes=[$names]; traffic: ${statuses:-none}"
    elif ! printf '%s' "$statuses" | grep -qE '"status":200'; then
      verdict=FAIL
      evidence="no status 200; calls=$count probes=[$names]; traffic: ${statuses:-none}"
    elif [[ ",$names," != *",todo,"* ]] || [[ ",$names," != *",task,"* ]]; then
      verdict=MODEL-PROBES
      evidence="calls complete but forced probes missed; probes=[$names]; traffic: ${statuses:-none}"
    else
      verdict=PASS
      evidence="calls=$count probes=[$names]; traffic: ${statuses:-none}"
    fi
  fi
  RESULTS+=("$id|$lane|$verdict|$evidence")
  echo "-- [$id] $verdict: $evidence"
  [ "$verdict" != "FAIL" ]
}

while IFS=$'\t' read -r usage id lane tc; do
  run_model "$id" "$lane" "$tc" || { [ "$STOP403" = 1 ] && break; }
done <<< "$ORDERED"

# ------------------------------------------------------- table
echo
echo "==================== FREE-LANE TOOL MATRIX ===================="
printf '%-36s %-9s %-14s %s\n' "model" "lane" "result" "evidence"
for r in "${RESULTS[@]:-}"; do
  IFS='|' read -r m l v e <<< "$r"
  printf '%-36s %-9s %-14s %s\n' "$m" "$l" "$v" "$e"
done
echo "==============================================================="
echo "panes + evidence: $WORK/"

if [ "$STOP403" = 1 ]; then exit 87; fi
for r in "${RESULTS[@]:-}"; do
  case "$r" in *"|FAIL|"*) exit 1;; esac
done
exit 0
