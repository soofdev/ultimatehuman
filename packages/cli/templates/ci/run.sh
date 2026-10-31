#!/usr/bin/env bash
# Local PR review gate (installed by `ultimatehuman ci install`): runs the reviewer prompt (PROMPT.md)
# through `claude -p` on the self-hosted runner, posts ONE marker-tagged PR
# comment (edited on re-runs) and maps the verdict to the job status:
#   BLOCK -> exit 1, PASS_WITH_RISKS / CLEAN -> exit 0,
#   review could not run / no parsable verdict -> failure comment + exit 1.
# While the reviewer works, the job log gets one progress line per minute
# (tool-call count + the latest tool), never the reviewer's text or thinking.
#
# Inputs (env, set by .github/workflows/pr-review.yml):
#   REPO PR_NUMBER BASE_REF BASE_SHA HEAD_REF HEAD_SHA GH_TOKEN RUN_URL
#   On the "Run workflow" button only REPO, DISPATCH_REF, DISPATCH_SHA and an
#   optional PR_NUMBER are set; the rest is resolved from the PR below.
# Optional: BUDGET_MINUTES (30), CLAUDE_TIMEOUT_MINUTES (38), CLAUDE_BIN,
#   CLAUDE_MODEL (fable), REVIEW_HOME (HOME for the claude process, set by
#   the runner unit).
set -uo pipefail

: "${REPO:?}" "${GH_TOKEN:?}"
PR_NUMBER="${PR_NUMBER:-}" BASE_REF="${BASE_REF:-}" BASE_SHA="${BASE_SHA:-}"
HEAD_REF="${HEAD_REF:-}" HEAD_SHA="${HEAD_SHA:-}"
DISPATCH_REF="${DISPATCH_REF:-}" DISPATCH_SHA="${DISPATCH_SHA:-}"
BUDGET_MINUTES="${BUDGET_MINUTES:-30}"
CLAUDE_TIMEOUT_MINUTES="${CLAUDE_TIMEOUT_MINUTES:-38}"
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude || echo "$HOME/.local/bin/claude")}"
# Model: the workflow passes the one chosen at install time; the alias tracks the newest Fable.
CLAUDE_MODEL="${CLAUDE_MODEL:-fable}"
# Base branch reviewed PRs target (button runs look up the open PR into it).
REVIEW_BASE="${REVIEW_BASE:-main}"
RUN_URL="${RUN_URL:-}"
MARKER='<!-- ultimatehuman-pr-review -->'

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKOUT="$(git -C "$HERE" rev-parse --show-toplevel)"
WORK="$(mktemp -d "${RUNNER_TEMP:-/tmp}/pr-review.XXXXXX")"
PROMPT_FILE="$WORK/prompt.md"
COMMENT_FILE="$WORK/comment.md"
PR_META_FILE="$WORK/pr-meta.md"
TRANSCRIPT="$WORK/claude-output.txt"   # stderr + final result text, as text mode printed it
# Full event stream, reasoning included: it stays in RUNNER_TEMP and is never
# printed, uploaded or posted; only the digest lines below come out of it.
STREAM="$WORK/claude-stream.jsonl"
STDERR_FILE="$WORK/claude-stderr.txt"
PROGRESS_STATE="$WORK/progress.json"
SCRATCH_DIR="$WORK/scratch"   # private per run: reviews of both repos can run at once
mkdir -p "$SCRATCH_DIR"
export GH_TOKEN GH_REPO="$REPO"

log() { echo "[pr-review] $*"; }

# One digest line from the part of the stream not read yet:
#   progress_line            -> "[review +12m] 148 tool events; last: Read app/x.py"
#   progress_line <verdict>  -> "[review +31m] done: 212 tool events; verdict: CLEAN"
REVIEW_START=$SECONDS
progress_line() {
  STREAM="$STREAM" PROGRESS_STATE="$PROGRESS_STATE" CHECKOUT="$CHECKOUT" \
  ELAPSED="$(( (SECONDS - REVIEW_START) / 60 ))" VERDICT="${1:-}" python3 - <<'PY' || true
import json, os
state_file = os.environ["PROGRESS_STATE"]
try:
    state = json.load(open(state_file))
except (OSError, ValueError):
    state = {"offset": 0, "events": 0, "last": ""}

def target(name, inp):
    for key in ("file_path", "notebook_path", "command", "pattern", "url", "query", "description", "path"):
        v = inp.get(key)
        if isinstance(v, str) and v.strip():
            v = v.strip().splitlines()[0].replace(os.environ["CHECKOUT"] + "/", "")
            return v if len(v) <= 80 else v[:77] + "..."
    return ""

try:
    with open(os.environ["STREAM"], "rb") as f:
        f.seek(state["offset"])
        chunk = f.read()
except OSError:
    chunk = b""
complete = chunk[: chunk.rfind(b"\n") + 1]  # a half-written last line waits for the next tick
state["offset"] += len(complete)
for line in complete.splitlines():
    try:
        event = json.loads(line)
    except ValueError:
        continue
    if event.get("type") != "assistant":
        continue
    for block in (event.get("message") or {}).get("content") or []:
        if isinstance(block, dict) and block.get("type") == "tool_use":
            state["events"] += 1
            inp = block.get("input") if isinstance(block.get("input"), dict) else {}
            state["last"] = ("%s %s" % (block.get("name", "?"), target(block.get("name"), inp))).strip()
json.dump(state, open(state_file, "w"))
head = "[review +%sm]" % os.environ["ELAPSED"]
if os.environ["VERDICT"]:
    print("%s done: %d tool events; verdict: %s" % (head, state["events"], os.environ["VERDICT"]), flush=True)
else:
    print("%s %d tool events; last: %s" % (head, state["events"], state["last"] or "-"), flush=True)
PY
}

# --- button runs: find the PR and its refs ----------------------------------
if [ -n "$DISPATCH_REF" ]; then
  if [ -z "$PR_NUMBER" ]; then
    PR_NUMBER="$(gh pr list --head "$DISPATCH_REF" --base "$REVIEW_BASE" --state open \
                  --json number --jq '.[0].number // empty')"
    [ -n "$PR_NUMBER" ] || { log "no open PR from $DISPATCH_REF into $REVIEW_BASE; nothing to review"; exit 1; }
  fi
  IFS=$'\t' read -r BASE_REF BASE_SHA HEAD_REF HEAD_SHA < <(
    gh pr view "$PR_NUMBER" --json baseRefName,baseRefOid,headRefName,headRefOid \
      --jq '[.baseRefName, .baseRefOid, .headRefName, .headRefOid] | @tsv')
  [ -n "$HEAD_SHA" ] || { log "could not read PR #$PR_NUMBER"; exit 1; }
  log "button run for $REPO#$PR_NUMBER ($HEAD_REF -> $BASE_REF)"
fi

# --- comment posting (find by marker, edit; else create) -------------------
post_comment() {
  local body_file="$1" final="$WORK/final-comment.md" id
  {
    echo "$MARKER"
    # GitHub caps comment bodies at 65536 chars; keep room for the footer.
    head -c 60000 "$body_file"
    echo
    echo
    echo "---"
    echo "<sub>Local Claude review · head \`${HEAD_SHA:0:12}\` · runner \`${RUNNER_NAME:-local}\`${RUN_URL:+ · [run log]($RUN_URL)} · re-runs edit this comment</sub>"
  } > "$final"
  id="$(gh api "repos/$REPO/issues/$PR_NUMBER/comments" --paginate \
        --jq ".[] | select(.body | startswith(\"$MARKER\")) | .id" | tail -n1)" \
    || return 1   # a failed lookup must not post a second comment
  if [ -n "$id" ]; then
    gh api -X PATCH "repos/$REPO/issues/comments/$id" -F body=@"$final" --jq .html_url
  else
    gh api -X POST "repos/$REPO/issues/$PR_NUMBER/comments" -F body=@"$final" --jq .html_url
  fi
}

fail_review() {
  local reason="$1" f="$WORK/failure.md"
  {
    echo "VERDICT: REVIEW FAILED — no verdict, the merge gate stays red"
    echo
    echo "The local Claude review could not produce a verdict: $reason"
    echo
    echo "Re-run the \`pr-review\` job once the cause is fixed. Last lines of the reviewer output:"
    echo
    echo '```'
    tail -n 40 "$TRANSCRIPT" 2>/dev/null | sed 's/```/`` `/g'
    echo '```'
  } > "$f"
  post_comment "$f" || log "could not post the failure comment"
  log "review failed: $reason"
  progress_line "REVIEW FAILED"
  exit 1
}

# The check lands on the dispatched commit, so it must be the PR's head.
if [ -n "$DISPATCH_SHA" ] && [ "$DISPATCH_SHA" != "$HEAD_SHA" ]; then
  fail_review "this run is for \`${DISPATCH_SHA:0:12}\` on \`$DISPATCH_REF\` but the PR head is \`${HEAD_SHA:0:12}\` on \`$HEAD_REF\`. Run the workflow on the PR's head branch at its latest commit."
fi

# --- assemble the prompt ----------------------------------------------------
# PROMPT.md says: send everything below its first `---` line to the agent.
# Placeholders are filled; the addendum is appended after the prompt text.
gh pr view "$PR_NUMBER" --json title,body,commits \
  --template '# {{.title}}{{"\n\n"}}{{.body}}{{"\n\n## Commits\n"}}{{range .commits}}- {{.oid}} {{.messageHeadline}}{{"\n"}}{{end}}' \
  > "$PR_META_FILE" 2>"$WORK/pr-meta.err" || fail_review "could not read PR #$PR_NUMBER metadata ($(head -c 300 "$WORK/pr-meta.err"))"

REPO="$REPO" PR_NUMBER="$PR_NUMBER" BASE_REF="$BASE_REF" BASE_SHA="$BASE_SHA" \
HEAD_REF="$HEAD_REF" HEAD_SHA="$HEAD_SHA" BUDGET_MINUTES="$BUDGET_MINUTES" \
COMMENT_FILE="$COMMENT_FILE" PR_META_FILE="$PR_META_FILE" SCRATCH_DIR="$SCRATCH_DIR" \
python3 - "$HERE" "$PROMPT_FILE" <<'PY' || fail_review "prompt assembly failed"
import os, re, sys, pathlib
here, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
lines = (here / "PROMPT.md").read_text().split("\n")
body = "\n".join(lines[lines.index("---") + 1:]).lstrip("\n")  # below the first `---`
keys = ["REPO", "PR_NUMBER", "BASE_REF", "BASE_SHA", "HEAD_REF", "HEAD_SHA",
        "BUDGET_MINUTES", "COMMENT_FILE", "PR_META_FILE", "SCRATCH_DIR"]
values = {k: os.environ[k] for k in keys}
values["PRODUCT_CONTEXT"] = (here / "PRODUCT_CONTEXT.md").read_text().strip()
addendum = (here / "ADDENDUM.md").read_text()
for k, v in values.items():
    body = body.replace("{{%s}}" % k, v)
    addendum = addendum.replace("{{%s}}" % k, v)
left = sorted(set(re.findall(r"\{\{[A-Z_]+\}\}", body + addendum)))
if left:
    sys.exit("unfilled placeholders: %s" % left)
out.write_text(body.rstrip("\n") + "\n\n" + addendum)
PY

# --- run the reviewer -------------------------------------------------------
log "running claude ($CLAUDE_MODEL) review of $REPO#$PR_NUMBER ($BASE_REF...$HEAD_REF @ ${HEAD_SHA:0:12}), cap ${CLAUDE_TIMEOUT_MINUTES}m"
(
  cd "$CHECKOUT"
  # Separate HOME: the reviewer must not load this machine's personal agent
  # memory/settings. Auth comes from CLAUDE_CODE_OAUTH_TOKEN (runner unit).
  if [ -n "${REVIEW_HOME:-}" ]; then mkdir -p "$REVIEW_HOME"; export HOME="$REVIEW_HOME"; fi
  export TMPDIR="$SCRATCH_DIR"
  # Print mode otherwise abandons background tasks (e.g. a base-branch build)
  # after 10 minutes and exits before the comment is written; the hard
  # timeout below still caps the whole review.
  export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0
  # No GitHub credentials for the reviewer: the wrapper fetched the PR metadata
  # and posts the comment itself, so an injected instruction has no token to use.
  unset GH_TOKEN GH_REPO GITHUB_TOKEN ACTIONS_RUNTIME_TOKEN ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL
  # GNU timeout (Linux; `gtimeout` from coreutils on macOS) caps the review.
  TIMEOUT_BIN="$(command -v timeout || command -v gtimeout || true)"
  [ -n "$TIMEOUT_BIN" ] || { echo "[pr-review] GNU timeout not found (install coreutils)" >&2; exit 2; }
  "$TIMEOUT_BIN" --kill-after=60 "${CLAUDE_TIMEOUT_MINUTES}m" "$CLAUDE_BIN" -p \
    --model "$CLAUDE_MODEL" \
    --output-format stream-json --verbose \
    --permission-mode bypassPermissions \
    --add-dir /tmp "$WORK" \
    --disallowedTools "Bash(gh pr comment:*)" "Bash(gh pr merge:*)" "Bash(gh pr close:*)" \
      "Bash(gh pr edit:*)" "Bash(gh pr review:*)" "Bash(gh pr ready:*)" "Bash(git push:*)" \
    < "$PROMPT_FILE" > "$STREAM" 2> "$STDERR_FILE"
) &
claude_pid=$!
REVIEW_START=$SECONDS
next_tick=60
while kill -0 "$claude_pid" 2>/dev/null; do
  sleep 5
  if [ $(( SECONDS - REVIEW_START )) -ge $next_tick ]; then
    progress_line
    next_tick=$(( next_tick + 60 ))
  fi
done
wait "$claude_pid"
rc=$?
# Rebuild what text mode used to print (stderr, then the final result text);
# the failure comment quotes its tail, so no reasoning ever reaches the PR.
python3 - "$STREAM" "$STDERR_FILE" > "$TRANSCRIPT" <<'PY' || true
import json, sys
stream, stderr = sys.argv[1], sys.argv[2]
try:
    sys.stdout.write(open(stderr, errors="replace").read())
except OSError:
    pass
result = None
try:
    for line in open(stream, errors="replace"):
        try:
            event = json.loads(line)
        except ValueError:
            # A cut-off event (timeout kill) can hold reasoning: drop it. Other
            # lines are plain messages claude printed outside the stream.
            if not line.lstrip().startswith("{"):
                sys.stdout.write(line)
            continue
        if isinstance(event, dict) and event.get("type") == "result":
            result = event.get("result")
except OSError:
    pass
if isinstance(result, str):
    print(result)
PY
log "claude exited rc=$rc"
[ $rc -eq 124 ] || [ $rc -eq 137 ] && fail_review "the reviewer hit the ${CLAUDE_TIMEOUT_MINUTES}-minute hard timeout"
[ -s "$COMMENT_FILE" ] || fail_review "the reviewer exited (rc=$rc) without writing its comment"

# --- read the gate block and map the verdict ---------------------------------
verdict="$(python3 - "$COMMENT_FILE" <<'PY'
import json, re, sys
text = open(sys.argv[1]).read()
blocks = re.findall(r"```json\s*(\{.*?\})\s*```", text, re.S)
if not blocks:
    sys.exit(1)
try:
    gate = json.loads(blocks[-1])
except ValueError:
    sys.exit(1)
v = str(gate.get("verdict", "")).strip().upper().replace(" ", "_")
if v not in ("BLOCK", "PASS_WITH_RISKS", "CLEAN"):
    sys.exit(1)
print(v)
PY
)" || fail_review "no parsable \`json\` gate block with a valid verdict in the reviewer comment"

post_comment "$COMMENT_FILE" || fail_review "could not post the review comment"
log "verdict: $verdict"
progress_line "$verdict"
[ "$verdict" = "BLOCK" ] && exit 1
exit 0
