# Local PR review

Installed by `ultimatehuman ci install`. `.github/workflows/ultimatehuman-pr-review.yml`
runs `run.sh` on a self-hosted runner (label `{{RUNNER_LABEL}}`). `run.sh` sends
`PROMPT.md` plus `ADDENDUM.md` to `claude -p --model {{MODEL}}`, posts one PR
comment that later runs edit (found by its `<!-- ultimatehuman-pr-review -->`
marker), and sets the `pr-review` check: red on BLOCK or when the review fails,
green on PASS_WITH_RISKS / CLEAN.

**Edit `PRODUCT_CONTEXT.md`**: it is the only per-repo part of the prompt
(intended behaviour that must never be reported as a bug, high-risk areas,
sibling repos).

## Job log

While the reviewer works, the `pr-review` step prints one line per minute,
e.g. `[review +12m] 148 tool events; last: Read app/tools/calculate.py`, and a
last line with the verdict. The full reviewer stream (its reasoning
included) stays in the runner's temp dir and is deleted with the job; it is
never printed, uploaded or posted.
