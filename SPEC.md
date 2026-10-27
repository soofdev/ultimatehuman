# ultimatehuman v1 technical spec

Status: draft for review. Scope: v1 = **radar → GitHub issues**. Auto-fix PRs and browser QA execution are v2. The environment manifest and playbooks are specified here so the v1 config schema does not break in v2.

Governing metric: **time-to-wow**, the minutes from `npx ultimatehuman init` to the first real, root-caused finding from the user's own data. Every design choice below is judged against it, and second against **precision**. A wrong finding costs more trust than a missed one.

---

## 1. Principles

1. **The AI can look, never touch.**
   - Source credentials are read-only.
   - The only write in v1 is creating an issue in one configured GitHub repo, and commenting on issues it filed itself.
   - No code writes, no deploys, no DB writes, no outbound messages.
2. **Evidence or silence.**
   - A finding exists only if every required evidence field (§7) is filled from data read during that run, with a deep link.
   - "No clear problems found" is a first-class result, shown verbatim.
   - Findings are never padded to fill a quota.
3. **Govern from the outside in.**
   - The engine shares the user's Claude subscription window with the human.
   - It reads the real remaining window before admitting work, keeps a human reserve, and parks instead of sleeping or dying (§5).
4. **One manifest, every surface.**
   - Each plugin's manifest drives the CLI wizard, the dashboard form and the `doctor` checks.
   - The config schema drives the dashboard config form.
5. **Nothing leaves the machine except:**
   - calls to the user's own trackers (read);
   - calls to Claude (via the user's own login or key);
   - the issue it files on GitHub.
   - There is no telemetry, phone-home, or hosted component in v1.

## 2. Architecture

```
            ┌───────────────────────── ultimatehuman daemon (one Node process) ─────────────────────────┐
 trackers   │  plugins (source)        radar run engine              governor          store (SQLite)  │
 PostHog ──►│  collect()/expand() ──►  collect→correlate→root-cause  admit()/park()    runs, findings, │
 Sentry  ──►│                          →dedupe→ready                 usage ledger      checkpoints,    │
            │                              │   ▲                        ▲               usage, issues   │
            │                              ▼   │                        │                               │
            │                         agent runner (claude -p / Agent SDK, read-only tools) ── Claude     │
            │                              │                                                            │
 GitHub ◄───│  plugin (output) file() ◄────┘ (human click or autoFile)                                   │
            │  HTTP + WS server on 127.0.0.1:4747  ◄──►  dashboard SPA (same origin)                     │
            └────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Packages** (pnpm monorepo):
  - `@ultimatehuman/sdk`: types only; this is what plugin authors depend on.
  - `@ultimatehuman/core`: config, auth, governor, radar, runner, store, server, daemon.
  - `@ultimatehuman/plugin-{posthog,sentry,github}`.
  - `@ultimatehuman/dashboard`: Vite + React SPA, built into static assets the daemon serves.
  - `ultimatehuman` (CLI).
- **Runtime:** Node ≥ 22, one process. SQLite through `node:sqlite`, or `better-sqlite3` if `node:sqlite` is still flagged in the supported Node range. Its schema is created and migrated by the engine at startup; there are no manual steps.
- **Data dir:** `~/.ultimatehuman/` holds `config.json5`, `state.db`, `runs/<runId>/` (signal bundles, agent transcripts) and `logs/`. `ULTIMATEHUMAN_HOME` overrides it.

## 3. Plugin interface

Source of truth: `packages/sdk/src/plugin.ts`. Summary:

```ts
interface PluginManifest {
  id: string; displayName: string; kind: "source" | "output";
  newcomerScore: number;            // 0-100, wizard offers easiest first
  requiredScopes: readonly string[]; // minimum read scopes; doctor warns on broader tokens
  credentials: readonly CredentialField[];
  options?: Record<string, OptionField>;
  docsUrl: string;
}
interface CredentialField {
  key: string; label: string; secret: boolean;
  preferredEnv: string; alternateEnv?: readonly string[];  // wizard auto-detect order
  helpUrl: string;   // deep link to the exact token-creation page
  helpText: string;  // which scopes to tick, one line
  default?: string; pattern?: string; optional?: boolean;
}
interface ProbeResult {
  ok: boolean;
  summary: string;                    // "Found 37 unresolved issues in web-app"
  detected?: Record<string, unknown>; // pre-fills options (org slug, project id)
  fix?: string;                       // next action on failure
  overScoped?: readonly string[];     // warning: token broader than needed
}
interface SourceAdapter {
  collect(ctx, window): AsyncIterable<Signal>;   // idempotent, read-only
  expand?(ctx, signalId): Promise<unknown>;      // stack trace / recording / events on demand
}
interface OutputAdapter {
  listCandidates(ctx, q): Promise<ExistingIssue[]>; // for dedupe
  file(ctx, finding): Promise<FiledIssue>;
  comment?(ctx, ref, body): Promise<void>;
}
```

**Read-only enforcement.** Plugins never call `fetch` directly. `ctx.http` exposes `get()` plus `query()`, and `query()` is allowed only for URLs matching the plugin's `readOnlyPostAllowlist` (for example PostHog's HogQL `POST /api/projects/:id/query`). Output plugins get a separate writer limited to the issue endpoints of the one configured repo. A plugin that tries any other method or URL throws. The error is logged and the step is aborted.

**Signal.** A normalised observation (`error_group`, `performance_regression`, `funnel_drop`, `event_anomaly`, `rage_click`, `session_recording`, `log_pattern`) with these fields:
- `id`, `count`, `usersAffected`, `firstSeen` and `lastSeen`;
- a deep `url`;
- correlation `keys` (release, route, fingerprint, hashed user ids, flag);
- a small redacted `excerpt`.

**Launch plugins:**

| id | reads | probe | signals |
|---|---|---|---|
| `sentry` | org:read, project:read, event:read | list orgs → projects → unresolved count in window | unresolved/regressed issues, latest event stack, release |
| `posthog` | query, recordings, error tracking, project read | list projects → event count 24h, error group count | `$exception` groups, funnel step drops vs 7-day baseline, rage/dead clicks, recordings linked to errors |
| `github` (output) | fine-grained, single repo: Issues RW, Contents R, Metadata R | repo visible + can list issues + label exists or creatable | n/a; also provides the read-only checkout for code pointers |

Datadog comes as a fast-follow (logs + APM; keys: API + Application key with read-only scopes).

**Third-party plugins.** These are npm packages named `ultimatehuman-plugin-*` that default-export a `Plugin` built with `definePlugin()`. They are listed in `config.plugins` and loaded only when named there. They are never auto-discovered.

## 4. Config

- **File:** a single file, `~/.ultimatehuman/config.json5`.
  - It is JSON5 (comments, trailing commas) and validated against a zod 4 schema (`packages/core/src/config/schema.ts`).
  - Unknown keys are an error: the daemon refuses to start, but `doctor` still runs.
  - `config schema` prints the JSON Schema.
- **Secrets:** they are only ever stored as refs.
  - The allowed forms are `"${SENTRY_AUTH_TOKEN}"`, `{source:"env", id}` or `{source:"file", path}` (the file must be 0600).
  - The schema rejects inline values for core secrets (Claude token, API key, account passwords).
  - Plugin credential maps accept plain strings for non-secret fields (host, org). The loader therefore runs a second, manifest-aware pass: a field declared `secret: true` must be a ref, or the daemon refuses to start and `doctor` names the field.
  - Refs are resolved into memory at use time, never written back, and never logged.
  - `config get` shows the ref, never the value.
- **Four equivalent edit paths**, all going through the same validate-then-atomic-write function, which keeps a `.bak` ring of 5:
  1. the wizard (`init`);
  2. `config get <path>` / `config set <path> <value>` (dot paths);
  3. the dashboard config form, generated from the JSON Schema, with field `description`s as help text;
  4. a hand edit. The file watcher hot-reloads it and shows the validation error in the dashboard and logs if the file is invalid.
- **`doctor`** checks, in order:
  - the file parses and validates;
  - every ref resolves;
  - every plugin probe passes;
  - scopes are not broader than `requiredScopes`;
  - at least one auth source answers;
  - the service unit points at the current binary;
  - the store schema is current;
  - no parked run is past its reset time.
- **`doctor --fix`:**
  - applies schema migrations (`version` field);
  - restores the last-known-good config if the current one is invalid;
  - re-arms parked runs;
  - rewrites the service unit.
  - The same migrations also run automatically at startup, and only ever write a config that validates.

Example:

```json5
{
  version: 1,
  auth: {
    sources: [
      { id: "sub", kind: "claude_login" },
      { id: "key", kind: "anthropic_api_key", apiKey: "${ANTHROPIC_API_KEY}", dailyCapUsd: 5 },
    ],
    switchOnExhaustion: true,
  },
  governor: { humanReservePct: 30 },
  radar: { schedule: "0 7 * * *", lookbackHours: 24, minUsersAffected: 2, maxFindingsPerRun: 5, autoFile: false },
  plugins: {
    sentry: { credentials: { authToken: "${SENTRY_AUTH_TOKEN}", org: "acme" } },
    posthog: { credentials: { apiKey: "${POSTHOG_PERSONAL_API_KEY}", host: "https://eu.posthog.com" } },
    github: { credentials: { token: "${GITHUB_TOKEN}", repo: "acme/web" }, options: { labels: ["ultimatehuman"] } },
  },
  environments: [],  // v2: see §10
}
```

## 5. Credentials, Claude auth and the window governor

### 5.1 Auth sources

Claude auth is a list of sources tried in `auth.order` (default: listed order):

| kind | how | marketed as |
|---|---|---|
| `claude_login` | reuse the Claude Code login already on the machine (the runner inherits it) | "uses your Claude subscription" |
| `claude_oauth_token` | `claude setup-token` output, stored as a ref, injected as `CLAUDE_CODE_OAUTH_TOKEN` | same, for servers/containers |
| `anthropic_api_key` | API key ref plus a **required** `dailyCapUsd` | "add an API key when you need more" |

Public docs describe only "subscription first, API key when you need more". With `switchOnExhaustion: true`, the pool moves to the next source when one is exhausted. Otherwise work parks.

### 5.1b Account setup UX (HARD requirement — claude_luxure parity)

Setting up CLI accounts must be as crystal-clear as the claude_luxure account picker (reference implementation: `vincent38wargnier/claude_luxure`, `src/cli/*-bridge.ts`, `AccountProvider` in `src/shared/types.ts`). Non-negotiables:

1. **Zero-step default.** If a Claude Code login exists on the machine, `init` uses it and prints one line: `✓ Claude · signed in via <source> · uses your subscription`. No question asked.
2. **One command / one card to add more.** `ultimatehuman accounts add` (CLI) and an **Accounts** card (dashboard) offer a flat picker: `Claude login` / `Claude setup-token (paste)` / `API key (paste + daily cap)` / `Custom endpoint (base URL + key env)` — later `Codex login`. Max ONE question per choice; secrets pasted once are stored chmod-600 local, config holds only refs.
3. **Every account is live-probed on add** and shows its proof line (`answered in 2.8s · window 12% used · resets 00:20`). A failing account is never saved silently.
4. **The accounts list IS the policy.** Rows show provider badge, label, live window meter; the list order is the fallback order; `switchOnExhaustion` is a visible toggle. Exactly like luxure's account picker, no hidden config.
5. **Per-provider runner bridges** normalize CLI streams into common events + a usage reading (port ClaudeBridge/CodexBridge from claude_luxure). The governor consumes "remaining budget" from the bridge interface, never from claude-specific fields. v1 ships `claude` + `custom`; `codex` bridge is a port, v1.5.
6. **Findings display the model that produced them.** Provider freedom never hides behind the brand's precision claim.

### 5.2 Reading the real window

- The runner invokes `claude -p --output-format stream-json`. The stream carries `rate_limit_event` messages with:
  - `rate_limit_info.status` (`allowed`, `allowed_warning`, `rejected`);
  - `resetsAt` (epoch seconds);
  - `rateLimitType` (`five_hour`, `seven_day`, …);
  - `utilization`.
- The governor stores the latest event per source together with its timestamp.
- Because the human also consumes the same window, an observation older than `staleAfterMin` (default 15) is refreshed with a minimal probe turn before admitting a large step. Only the documented fields are used; anything marked internal is ignored.
- If no utilization is available (an older CLI, or an API key), the governor falls back to its own usage ledger and treats the window as unknown. That means admitting one small step at a time and re-reading after each.

### 5.3 Admission rules (`packages/core/src/governor/window.ts`)

1. Every agent step carries an estimate (`windowPct`, `usd`) taken from a rolling p75 of past steps of the same kind. Seed values are used until there are 5 samples.
2. **Subscription:** admit only if `used + estimate ≤ 100 − humanReservePct`. The default reserve is 30.
3. **API key:** admit only if `spentToday + estimate ≤ dailyCapUsd`. "Spent" comes from the token usage the CLI or SDK reports per step (the ledger), not from estimates.
4. If nothing admits, the run is **parked**:
   - the phase checkpoint is persisted;
   - the run state becomes `parked`, with `parkedUntil = earliest resetsAt` (or local midnight for caps);
   - a single timer is armed in the daemon. Timers are re-armed from the store on every boot.
   - There is no sleeping child process, and the dashboard shows the parked state and the time it resumes.
5. **Limit hit mid-step** (`status: rejected`, or a limit error): the step result is discarded, the run parks at the last completed phase, and the step is re-admitted after the reset. A step is never retried in a loop.
6. **Concurrency:** `maxConcurrentAgents` (default 1) caps parallel steps. The radar is a background job and must never starve the human's interactive use.
7. **Meter:** the dashboard header shows `window 78% used · resets 17:00 · 3 items queued`. On API keys it shows `$1.20 of $5.00 today`.

### 5.4 Agent runner

- **Interface:** `packages/core/src/runner/agent.ts`.
- **Default implementation:** a `claude -p` subprocess per step. Each step gets:
  - an explicit read-only tool allowlist (`Read`, `Grep`, `Glob`; no `Bash`, `Write`, `Edit` or web);
  - `--max-turns`;
  - a working directory containing only the run's signal bundle plus an optional read-only repo checkout.
  - The final answer must validate against the step's JSON schema, and one repair retry is allowed.
- **Alternative:** the Agent SDK implementation is a drop-in with the same contract.
- **Step kinds:** `correlate` (optional; deterministic first), `root_cause`, `dedupe`, `write_issue`.

## 6. Radar run lifecycle

```
scheduled ─► collecting ─► correlating ─► root_causing ─► deduping ─► ready ─► (file) ─► done
                 │              │               │              │
                 └──────────────┴──── parked ◄──┴──────────────┘ (governor) ── resume at reset
                                    failed (with reason, never silent)
```

- **Triggers:** a cron `radar.schedule`, the "Run now" button / `POST /api/runs`, and **onboarding**. The first pass starts during setup as soon as one source and one auth source probe green.
- **Single-flight:** one run at a time. A second trigger while one is running returns the running run.

1. **collect** (no LLM): every enabled source yields signals for `[now − lookbackHours, now]` into `runs/<id>/signals.jsonl`. Per-source failures are recorded and the run continues with the remaining sources.
2. **correlate** (deterministic first): group signals sharing a key, such as error fingerprint, release, route, the same hashed users within ±10 min, or a recording linked to an error. Clusters are ranked by `usersAffected × trend`. Only the top `maxFindingsPerRun × 2` clusters go on. An LLM `correlate` step runs only on ambiguous merges.
3. **root-cause** (one agent step per cluster, governor-admitted). The agent may call `expand` via pre-fetched files. With a repo connected it reads code at the release SHA. Its output is a `Finding` draft, and it must:
   - commit to one root-cause statement, or say `not established`;
   - cite evidence ids for every reasoning claim;
   - list what it ruled out;
   - give a reproduction recipe or say `notEstablished`;
   - list open questions.
4. **gate** (deterministic, then adversarial). Drop the draft if any of these hold:
   - a required evidence field is empty;
   - an evidence item has no URL;
   - a quote is not found verbatim in the bundle (quote re-grep);
   - `usersAffected < minUsersAffected` (unless severity is critical);
   - the signal predates a release that already shipped a fix and no recurrence is seen.
   - A fresh adversarial agent step then tries to break each surviving draft, with verdicts `holds`, `partly` (rewrite) or `broken` (drop). Dropped drafts are kept in `runs/<id>/dropped.json` and listed in the dashboard run detail, so nothing is silently discarded.
5. **dedupe:** in order: fingerprint match in the store, then open and recently closed (90 days) issues from `output.listCandidates()` matched by meaning. Outcomes:
   - **duplicate** of an issue this tool filed: append an occurrence comment (when `autoFile`) or show a "recurred" badge;
   - **related** to a human-filed issue: show "covered by #123" and never write to it;
   - **regression** of a closed issue: a new finding linked to the old one;
   - **new**.
   - When unsure, the finding is treated as a duplicate.
6. **ready:** findings appear in the feed.
   - **File to GitHub** renders the issue body from the finding (title = symptom; sections: Impact, Root cause, Evidence with links, Reproduction, Suggested direction, Not established, Fingerprint) and creates the issue with the configured labels.
   - **Dismiss** requires a one-line reason, which is stored and fed back as a suppression rule for the same fingerprint.
7. **done:** a summary is stored. An empty run sets `emptyReason`, for example "No clear problems found: 412 errors from 3 sources, all below the 2-user floor or already tracked in #88, #91."

## 7. Finding format

Source of truth: `packages/sdk/src/finding.ts`.

- **Required:**
  - `title` (symptom, 90 characters or fewer);
  - `severity`;
  - `confidence` (`confirmed` | `likely`);
  - `symptom`;
  - `impact {occurrences, firstSeen, lastSeen, trend, usersAffected?}`;
  - `rootCause {statement, reasoning[{claim, evidenceIds}], codePointers?, ruledOut?}`;
  - at least 2 `evidence[]` items `{id, sourcePluginId, kind, url, excerpt, observedAt}`, from at least 1 source;
  - `reproduction` (steps, or `notEstablished` with a reason);
  - `openQuestions[]` (may be empty, must be present);
  - `dedupe {fingerprint, matchedIssue?}`.
- **Fingerprint:** `<area>.<component>|<failure-mode>`, a stable slug of the root cause rather than the symptom. Two symptoms of one cause share a fingerprint.
- **Redaction:** emails, names, IPs and tokens in excerpts are masked before an excerpt is stored or rendered. User ids are hashed per install.

## 8. Dashboard and API

### 8.0 The dashboard IS a cockpit (HARD requirement — Vincent, 2026-10-27)

The product's interface identity is a **decision cockpit**, not an analytics dashboard. Reference implementation for the interaction grammar and polish bar: the private pipeline's claims cockpit (build legs: read `magify_next` `/administration/claims` as design reference — the public repo and docs never mention it). Non-negotiables:

1. **One surface, card-based.** Everything the radar wants from the human arrives as a card in one feed: findings to rule on, drafts it dropped (inspectable), decisions it needs, run outcomes. No hunting across pages to "manage" the radar; the pages (Runs/Usage/Config) are drill-downs, the cockpit is home.
2. **Rulings are ground truth.** Every card offers explicit rulings — v1: **File** (= confirm, creates the issue), **Dismiss with reason** (= wrong, becomes a suppression rule), **Not now** (parks). Rulings are stored, shown on the card's history, and OVERRIDE future runs: a dismissed fingerprint never resurfaces without new evidence, a confirmed one tracks recurrence. v2 adds fix-pipeline rulings (approve fix, exam verdicts) to the same feed — same grammar, more card types.
3. **The radar asks, the human rules, nothing proceeds silently.** Any card type that implies action defaults to waiting for a ruling (autoFile stays off until explicitly enabled).
4. **Sexy is a requirement, not a nice-to-have.** The cockpit is the screenshot people share; it gets the design budget. Card anatomy, severity accents, evidence chips and ruling buttons follow the claims-page bar; reference-tier polish (Typefully/Buffer).

- **Serving:** the daemon serves the SPA and the API on `127.0.0.1:4747`, same origin.
- **Auth:**
  - `ultimatehuman dashboard` prints `http://127.0.0.1:4747/login#code=<single-use>`, valid for 10 minutes.
  - The code is in the URL fragment, so it never appears in request lines or proxy logs.
  - The SPA POSTs the code to `/api/auth/redeem` and receives an `HttpOnly; SameSite=Strict` session cookie valid for 7 days. The fragment is then wiped.
  - No bearer token ever sits in a URL or in JS-readable storage.
  - Binding to a non-loopback host requires `server.allowRemote: true` and prints an SSH-tunnel recommendation.

**Pages (v1):**

1. **Setup (onboarding):**
   - Auto-detects Claude auth and tracker keys from the environment, as a checklist with live probes ("✓ Sentry: found 37 unresolved issues in 2 projects").
   - Asks only for what is missing; each missing field links to its exact `helpUrl`.
   - Starts the first pass the moment one source plus auth are green, with a live phase timeline over WS.
   - Ends on the first finding or on the honest empty result.
2. **Findings:**
   - A feed of finding cards with severity, users affected, trend, and plain-words title.
   - Expanding a card shows the evidence links, root-cause chain, and "Not established".
   - Actions: **File to GitHub** (with a preview of the issue body), **Dismiss** (reason required).
   - Badges: recurred, covered by #N, regression of #N.
   - Tabs: New / Filed / Dismissed.
3. **Runs:** history, phase timeline, signals per source, dropped drafts with their reasons, the parked state, and a "Run now" button.
4. **Usage:** the window meter per auth source, reserve line, reset time, queued steps, today's API spend against the cap, and spend per run.
5. **Config:** a form generated from the JSON Schema. Secrets show as ref pickers (env var name), never as values. Also shows `doctor` results with one-click fixes.

**REST** (types: `packages/sdk/src/api.ts`):

```
GET  /api/health                      POST /api/auth/redeem    POST /api/auth/logout
GET  /api/status                      GET  /api/onboarding/detect
POST /api/plugins/:id/probe           GET|PATCH /api/config    GET /api/doctor
GET|POST /api/runs                    GET /api/findings        GET /api/findings/:id
POST /api/findings/:id/file           POST /api/findings/:id/dismiss
```

**WS** `/api/events` (cookie-authenticated) carries `run.phase`, `finding.new`, `finding.updated`, `window.updated` and `probe.result`.

**CSRF:** all mutating routes require the `SameSite=Strict` cookie plus an `x-uh-csrf` header echoed from `/api/status`.

v2 adds a React embed kit (`@ultimatehuman/react`) that renders the same pages inside an existing admin app, against a remote daemon URL.

## 9. Security model

| Asset | Rule |
|---|---|
| Tracker tokens | read-only scopes only; `requiredScopes` displayed at creation; probe reports over-scoping; stored as env/file refs; resolved in memory |
| GitHub token | fine-grained, single repo, Issues RW + Contents R; the writer refuses any other endpoint |
| Claude auth | user's own login / setup-token / key; never copied into config; injected per subprocess only |
| Agent tools | read-only allowlist; cwd = run bundle (+ read-only repo checkout); no shell, no network tools |
| Data at rest | `~/.ultimatehuman` 0700, db + bundles 0600; excerpts redacted; `runs/` pruned after `retentionDays` (default 30) |
| Data in flight | trackers (read), Claude (prompt = redacted bundle), GitHub (issue body). Nothing else; no telemetry |
| Dashboard | loopback bind, single-use fragment login, HttpOnly cookie, CSRF header, no token in URL |
| Prompt injection | tracker content is untrusted data: wrapped in delimited data blocks, the agent has no write tools, issue bodies are rendered from structured fields (no raw agent markdown), links are allowlisted to the configured source hosts |

## 10. Test environments and playbooks (spec only in v1; executor is v2)

Config `environments[]` (already in the v1 schema, validated, unused by v1 code):

```json5
environments: [{
  name: "staging",
  url: "https://staging.acme.dev",
  deployCheck: { kind: "version_endpoint", target: "/api/version", expect: "matches_pr_head" },
  accounts: [
    { role: "member", username: "${STAGING_MEMBER_USER}", password: "${STAGING_MEMBER_PASS}" },
    { role: "end_user", signupPlaybook: "signup.md" },      // create fresh each run
  ],
  boundaries: { neverHosts: ["acme.com", "app.acme.com"], noOutboundEmail: true, paymentsTestModeOnly: true,
                extraRules: ["Never delete workspaces you did not create"] },
  playbooksDir: "playbooks",
}]
```

**Playbooks** are freeform markdown in `~/.ultimatehuman/playbooks/` (or in the repo under `.ultimatehuman/playbooks/`). They have an optional front-matter block followed by plain steps the QA agent reads:

```markdown
---
id: signup
environment: staging
role: end_user
produces: [account]          # what later playbooks can rely on
---
1. Open /signup. Use an address at the test inbox domain `+uh-{{runId}}@example.test`.
2. The verification code is shown on /dev/last-email (staging only).
3. Done when the dashboard shows "Welcome".
```

**Onboarding smoke probe (v2):** Playwright follows `signup.md` on the environment, takes a screenshot at each step, enforces `boundaries.neverHosts` at the network layer, and shows "✓ I can enter your test environment" with the screenshots.

**v2 fix loop (for orientation only):**
- a fix PR from a read-only clone;
- the deploy check confirms the PR head is on staging;
- a hostile exam replays the finding's reproduction BEFORE/AFTER with annotated screenshots;
- the verdict is exactly `PASS`, or `FAIL: <reason>` attached to the PR;
- a human merges and a human deploys.

## 11. Install flows

1. **Primary:** `npx ultimatehuman init`.
   - Detect → probe → write config → offer `service install` → print the login link → first pass starts.
   - Non-interactive equivalent:
     `npx ultimatehuman init --non-interactive --auth claude-login --sentry-token-env SENTRY_AUTH_TOKEN --github-repo acme/web --github-token-env GITHUB_TOKEN --service --json`.
     Every prompt has a flag, a missing required value exits 2 with the exact missing flag named, and `--json` prints a machine summary.
2. **Service:** `ultimatehuman service install|uninstall|status`. This writes a systemd user unit (with an enable-linger hint) or a launchd agent. There is no root, and the unit runs `ultimatehuman start`. Doctor checks for drift.
3. **Docker:** `docker compose up` with a volume for `~/.ultimatehuman` and an env file for refs. Claude auth uses a `claude setup-token` source.
4. **Later:** Railway/Render templates (a single container plus a volume). The dashboard is reached through the platform's private networking or an SSH tunnel.
5. **Agent-install doc** at the stable path `docs/agent-install.md`. It is written for Claude Code, so a user can paste "Install ultimatehuman from <repo url>/docs/agent-install.md". The outline:
   - preconditions check (Node ≥ 22, `claude` logged in) with exact commands;
   - discover keys: which env vars to look for, and ask the human only for those missing, naming the `helpUrl`;
   - the non-interactive `init` command with all flags;
   - verification probes: `ultimatehuman doctor --json` must report every check ok, and `curl 127.0.0.1:4747/api/health`;
   - optional `service install` + `service status`;
   - hand the human the login link (never a bare token);
   - rollback: `service uninstall`, `rm -rf ~/.ultimatehuman` after confirming with the human;
   - hard rules for the installing agent: never paste secrets into config, never widen token scopes, never run as root.

## 12. Non-goals for v1

- Auto-fix PRs.
- Browser QA execution.
- Multi-repo output.
- Hosted SaaS.
- Team accounts / RBAC.
- Non-GitHub trackers as output.
- Slack/Telegram notifications. These are post-v1 via a notifier interface; the dashboard inbox comes first.
