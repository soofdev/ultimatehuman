# Setup grade

Everything in ultimatehuman is optional. The **setup grade** tells you how much of the
pipeline an install actually uses, and what to switch on to get the next tier. It is shown
as a badge in the dashboard (Config page header) and in detail under **Config > Setup grade**
(`GET /api/setup-grade`).

The grade is a pure function (`packages/core/src/setup/grade.ts`, `gradeSetup`) over:

- the validated config,
- the raw config file (to tell a choice you *made* from a default),
- cheap local probes (`gradeProbes`): file-system checks only, no network, no agent.

Each tier needs **every check of its own tier and of all tiers below it**.

## Tiers

**Bronze** — the radar can run
- `repos`: at least one repo configured, and every configured path exists on disk
- `claude`: the `claude` CLI is found (`~/.local/bin/claude`, `$PATH`, or `ULTIMATEHUMAN_CLAUDE_BIN`)

**Silver** — it runs unattended, safely
- `sources`: at least one tracker plugin (Sentry, PostHog, Datadog) is configured and enabled
- `notifications`: `notifications.telegram.enabled` is on, or the Telegram door of the setup chat is (`chat.telegram.enabled` with a `botToken` ref, see [chat.md](chat.md)). Either way the install can reach you on your phone.
- `guard`: a usage guard is on: `governor.humanReservePct > 0`, or an API-key source (which requires `dailyCapUsd`)

**Gold** — it closes the loop on a test environment
- `fixLoop`: `features.fixLoop` is on (reserved: the fix loop ships later, so Gold is not reachable yet by design)
- `validationGate`: `features.validationGate` is written explicitly in the config file, `true` or `false` (a decision, not a default)
- `testUrl`: at least one repo has a `testUrl`

**Platinum** — production-grade operations
- `ci`: the CI check (`ultimatehuman ci install`) is present in every configured repo
  (`.github/workflows/ultimatehuman-pr-review.yml`)
- `failover`: two or more auth sources with `auth.switchOnExhaustion` on
- `ledger`: `features.ledger` is on (reserved)

## Pending ledger

`init` never blocks on something it cannot finish alone (a key an admin holds, a staging URL not
deployed yet). Each skipped step becomes one entry in the config's `pending` list:

```json5
{ id: "datadog.key", label: "Datadog read-only keys", why: "Found dd-trace in web-app. ...",
  unlock: "Get API key + Application key (logs_read_data, ...), then run `ultimatehuman key DATADOG_API_KEY` ...",
  tier: "silver", plugin: "datadog", envVars: ["DATADOG_API_KEY", "DATADOG_APP_KEY"],
  activate: { plugins: { datadog: { credentials: { apiKey: "${DATADOG_API_KEY}", appKey: "${DATADOG_APP_KEY}", site: "datadoghq.eu" } } } },
  since: "2026-10-30T18:01:30Z" }
```

An entry resolves when every `envVars` name is set (shell or `<home>/engine.env`), or when its
`gradeCheck` passes (e.g. `testUrl`, `notifications`, `sources`). The engine checks once a minute
on its existing 30 s tick (`packages/core/src/setup/concierge.ts`): it re-reads `engine.env`,
probes a source plugin read-only with the new key (a failing key is remembered by hash and retried
only once it changes), applies `activate`, removes the entry, recomputes the grade and posts the
result in the setup chat and, when the Telegram door is on, to Telegram. If no radar pass has run
yet (init found no tracker), the first pass starts there.

The ledger is shown at the end of `init`, on the dashboard Setup page and under Config > Setup
grade, and it is part of every chat turn's prompt, so "what's missing?" gets a real answer.
Secrets are added with `ultimatehuman key <ENV_NAME>` (prompted, masked, written 0600), never
pasted into the chat.

## Adding a check

Add one entry to the `checks` list in `gradeSetup` with its tier, a plain label and a hint
that says exactly what to do. Keep probes cheap and local: the grade is recomputed on every
Config page visit.
