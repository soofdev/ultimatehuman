# CI check: a Claude PR review on your own machine

`ultimatehuman ci install` writes a pre-merge review check into a repo: a GitHub Actions
workflow that runs `claude -p` on **your** machine through a **self-hosted runner**, posts
one PR comment, and turns the `pr-review` check red on a `BLOCK` verdict. It is a
generalized copy of the review gate the reference pipeline runs on its own repos.

```sh
ultimatehuman ci install                      # every repo in config `repos`
ultimatehuman ci install --repo web           # one configured repo, by name
ultimatehuman ci install --repo ~/code/api    # any checkout, by path
# options: --base <branch> (main)  --runner-label <label> (ultimatehuman-review)
#          --model <id> (fable)    --force (overwrite, except PRODUCT_CONTEXT.md)
```

It only writes files. It never commits, pushes or touches GitHub: you review and commit them.

## What it writes

- `.github/workflows/ultimatehuman-pr-review.yml` — runs once per PR into the base branch
  (opened / reopened, same-repo PRs only, never forks), plus a **Run workflow** button
  (`workflow_dispatch`, optional `pr_number`) for re-reviews.
- `.github/review/run.sh` — assembles the prompt, runs the reviewer with no GitHub token,
  prints one progress line per minute, posts/edits the comment, maps the verdict.
- `.github/review/PROMPT.md` — the reviewer prompt (portable; filled at run time).
- `.github/review/ADDENDUM.md` — CI delivery rules (the wrapper posts, not the agent).
- `.github/review/PRODUCT_CONTEXT.md` — **the one file you maintain**: generated from your
  config (repo name, notes, test URL, sibling repos) with placeholders for intended
  behaviour and high-risk areas. Never overwritten once written.
- `.github/review/README.md` — how the check behaves.

## The contract (kept from the original)

- **One marker comment.** The comment starts with `<!-- ultimatehuman-pr-review -->`;
  re-runs find it and edit it instead of posting a new one.
- **VERDICT.** The comment's first line is the verdict, and its last ```json block is the
  gate: `{"verdict": "BLOCK" | "PASS_WITH_RISKS" | "CLEAN", ...}`.
  `BLOCK` → job fails (red). `PASS_WITH_RISKS` / `CLEAN` → green.
  No parsable gate block, a timeout, or a crash → a "REVIEW FAILED" comment and a red job.
- **No credentials for the reviewer.** `run.sh` unsets `GH_TOKEN` and the Actions tokens
  before starting Claude and blocks `gh pr comment/merge/close/edit/review` and `git push`.

## Self-hosted runner requirement

The review runs on a machine you control, using its Claude Code login. You need:

1. A machine (Linux is the tested path; macOS works with GNU `timeout` from coreutils,
   found as `timeout` or `gtimeout`) with `git`, `gh`, `python3` and a logged-in `claude` CLI
   (or `CLAUDE_CODE_OAUTH_TOKEN` in the runner's environment).
2. A GitHub Actions self-hosted runner registered on the repo (Settings → Actions → Runners
   → New self-hosted runner) with the extra label **`ultimatehuman-review`** (or the one you
   passed to `--runner-label`), running as a service.
3. Optional: `REVIEW_HOME` in the runner's environment, so the reviewer gets a clean HOME
   without your personal Claude memory/settings.
4. To make it a merge gate: add `pr-review` as a required status check in branch protection.

The Run-workflow button only appears once the workflow file is on the default branch.
Until then: `gh workflow run ultimatehuman-pr-review.yml --ref <branch>`.

The setup grade's Platinum tier counts the check as installed when
`.github/workflows/ultimatehuman-pr-review.yml` exists in every configured repo.
