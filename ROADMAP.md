# Roadmap: v1 build legs

Each leg is a self-contained unit of work with its own acceptance criteria. Legs run in order unless marked parallel.

"Acceptance" means it was demonstrated by running it, not reasoned about. For UI legs, that demonstration happens in a real browser, with screenshots attached to the leg report.

## Leg 0: Scaffold (done)

**Scope:** pnpm monorepo (`sdk`, `core`, `plugins/{posthog,sentry,github}`, `dashboard`, `cli`), typed stubs, SPEC, README draft.

**Acceptance:** `pnpm install && pnpm -r typecheck` passes clean; the dashboard `vite build` passes.

## Leg 1: Core engine

**Scope:**
- **Config:** load, hot-reload, atomic write with a `.bak` ring, `config get/set/schema`.
- **Secrets:** ref resolution.
- **Store:** SQLite with startup-created schema plus migrations (runs, findings, checkpoints, usage, filed issues, dismiss rules).
- **Scheduler:** cron, single-flight, Run now.
- **Run state machine:** phases persisted before work.
- **Governor:** `rate_limit_event` ingestion, reserve, API daily cap, park/resume timers re-armed on boot.
- **Runner:** `claude -p` runner with a read-only tool allowlist, schema-validated output, one repair retry.
- **Server:** HTTP + WS on loopback with single-use login links and CSRF.
- **Runtime:** a build step (tsup) so the CLI runs under plain `node`.

**Acceptance:**
1. **Fresh boot:** a fresh `ULTIMATEHUMAN_HOME` boots and creates its db schema itself, with no manual steps.
2. **Crash resume:** a fake source plugin plus a stub runner drive a full run to `done`. Killing the process mid-`root_causing` and restarting resumes at that phase without re-collecting.
3. **Park and resume:** with the runner forced to report `rejected` + `resetsAt = now+2min`, the run parks, the status shows `parked_until_reset`, there is no child process alive during the park, and the run resumes automatically after the reset.
4. **Reserve gate:** with utilization at 71% and a 30% reserve, nothing is admitted.
5. **Auth hygiene:** a login link works once; the second use returns 401; no token ever appears in the server access log.

## Leg 2: Launch plugins (parallel after Leg 1 types freeze)

**Scope:**
- **Sentry:** probe, collect (unresolved/regressed issues in window, latest event, release), expand (full stack).
- **PostHog:** probe, collect (`$exception` groups, funnel step drops vs a 7-day baseline, rage clicks, error-linked recordings as text timelines), expand.
- **GitHub:** probe, `listCandidates`, `file`, `comment`, plus the single-repo writer guard.
- **All plugins:** a read-only HTTP wrapper with an allowlist, over-scope detection where the provider exposes token scopes, and recorded-fixture adapters for offline development.

**Acceptance:**
1. **Probes:** each probe, run against a real free-tier account, prints a true summary sentence.
2. **Write guard:** the writer guard refuses a non-allowlisted POST (demonstrated).
3. **Over-scope:** a deliberately over-scoped token produces an `overScoped` warning.
4. **Issue body:** a filed issue renders correctly on GitHub; a screenshot of the issue page is in the report.

## Leg 3: Radar quality

**Scope:**
- **Correlate:** deterministic correlation.
- **Root-cause prompt:** the root-cause step prompt and output schema.
- **Gate:** the deterministic gate (required fields, quote re-grep, user floor) plus the adversarial agent step.
- **Dedupe:** fingerprint first, then meaning-match vs open/90-day-closed issues.
- **Empty result:** an honest `emptyReason`.
- **Bench:** a held-out benchmark of 10 seeded incidents in a demo app plus 10 noise-only days.

**Acceptance:**
1. **Precision:** on the held-out benchmark, precision is at least 0.9 (filed findings that are real) and recall is at least 0.6.
2. **Noise days:** every noise-only day returns an empty result.
3. **Duplicates:** zero duplicate filings across 3 consecutive runs over the same data.
4. **Independence:** prompts are never evaluated on their own examples.

## Leg 4: Dashboard

**Scope:**
- **Setup page:** onboarding (detect → probe checklist → missing-only fields with help links → live first pass over WS).
- **Findings page:** feed (cards, evidence, File to GitHub with preview, Dismiss with reason).
- **Runs page:** with dropped drafts.
- **Usage page:** meter.
- **Config page:** form generated from JSON Schema, secrets as ref pickers, doctor results.

**Acceptance:**
1. **Onboarding:** in a real browser, a clean machine with Sentry + GitHub env vars set reaches a first finding (or the honest empty state) without typing any credential.
2. **Screenshots:** every page is shot at desktop and mobile widths.
3. **Config round-trip:** editing config in the form is reflected by `config get`, and a hand edit appears live in the form.

## Leg 5: Install paths

**Scope:**
- **`init`:** interactive plus `--non-interactive` (a flag for every prompt, exit 2 naming the missing flag, `--json`).
- **`service install/uninstall/status`:** systemd user unit and launchd agent.
- **`doctor` / `doctor --fix`:** migrations, last-known-good restore, re-arm parked runs, unit drift.
- **Packaging:** Dockerfile + compose, and npm publish dry-run.
- **`docs/agent-install.md`:** completed.

**Acceptance:**
1. **Fresh VM:** on a fresh Ubuntu VM and a fresh macOS user, `npx` → first pass works end to end; the transcript and the time-to-wow minutes are recorded.
2. **Agent install:** a Claude Code session given only the agent-install doc URL completes the install non-interactively and passes `doctor --json`.
3. **Repair:** `doctor --fix` repairs a deliberately broken config and a stale unit.

## Leg 6: Reference deployment (dogfood gate)

**Scope:** run ultimatehuman in shadow mode against a real production SaaS that already has a mature internal triage process:
- read-only;
- `autoFile: false`;
- output to a private sandbox repo.

Compare it daily, for 14 days, against the issues that team actually confirmed.

**Acceptance (go/no-go for public launch):**
1. **Precision:** at least 0.9 on findings a human rated.
2. **Agreement:** at least half of the team's real confirmed incidents in the window were also surfaced.
3. **Governor:** zero governor incidents (the human was never locked out of their own Claude usage).
4. **Reliability:** zero silent run deaths.
5. **Time-to-wow:** a median under 15 minutes on three fresh installs by people who did not build it.

## Leg 7: Launch polish

**Scope:**
- **README:** a GIF of onboarding to the first finding.
- **Docs site:** quickstart, plugin authoring guide, security model page.
- **Datadog plugin:** fast-follow.
- **Repo hygiene:** `CONTRIBUTING`, issue templates, Apache-2.0, a GitHub Actions CI (typecheck + fixture tests).
- **Release:** `0.1.0` on npm.

**Acceptance:**
1. **Outsider review:** a fresh-eyes review of the README and quickstart by someone outside the project, with findings addressed.
2. **CI:** CI is green.
3. **Publish:** an npm publish of `0.1.0` (the human publishes).

## v2 (not scheduled)

- **Fixes:** auto-fix PRs from a read-only clone.
- **Environment work:** the environment smoke probe, plus a hostile-exam QA executor driven by `environments[]` + playbooks, with screenshot evidence on the PR.
- **Embedding:** the React embed kit.
- **Hosting:** Railway/Render templates.
- **Notifications:** a notifier interface (Slack, Telegram, email digests).
