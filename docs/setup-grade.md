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

## Adding a check

Add one entry to the `checks` list in `gradeSetup` with its tier, a plain label and a hint
that says exactly what to do. Keep probes cheap and local: the grade is recomputed on every
Config page visit.
