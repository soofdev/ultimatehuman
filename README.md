# ultimatehuman

**A self-hosted bug radar: it reads your Sentry and PostHog, finds the real product problems behind the noise, and files evidence-rich GitHub issues. Then a human takes it from there.**

## Kill AI slop: the AI can look, never touch

Most AI dev tools write code nobody asked for and claim it works. ultimatehuman starts from the opposite end:

- **Read-only access.** It connects to your trackers with read-only credentials.
- **Issues only.** The one thing it writes is an issue in a single repo you choose.
- **Evidence or nothing.** Every finding cites real events with links you can click, and it says plainly what is not known yet. "No clear problems found" is a valid answer; it never pads a list.
- **Fixes prove themselves (planned).** When fixes arrive in v2, they come as pull requests that must reproduce the bug and then prove the fix in a real browser on your test environment, examined like a hostile reviewer would.
- **Humans stay in charge.** A human merges, and a human deploys.

## Pipelines: suggestions you own

What runs is a list of **pipelines** (`docs/pipelines.md`). Each one is plain data: which sources
feed it, which signal types it keeps, its schedule, its own versioned briefs (the judgment its
agents apply), and per-pipeline model and gate overrides. One generic runtime runs any of them, one
pass at a time. Two templates ship as suggestions: **bug-radar** (trackers and analytics in,
root-caused user-facing bugs out) and **security-check** (a daily read-only audit of the watched
repos: committed secrets, risky dependencies, auth patterns). Adding a template copies it into your
config; from then on you edit, disable, delete or add pipelines in Config > Pipelines, through the
setup chat, or by hand. Any tool can also enqueue a ticket with `POST /api/findings`
(`docs/tickets-api.md`).

## Quick start

From a fresh machine (macOS or Linux, no Node needed):

```sh
git clone https://github.com/vincent38wargnier/ultimatehuman.git && cd ultimatehuman
bash scripts/bootstrap.sh      # Node 22 via nvm if missing -> pnpm -> install -> build -> init
```

`bootstrap.sh` is idempotent and never uses sudo (`--no-init` stops after the build). `init` asks
which repos to watch, scans their dependency manifests for Sentry/PostHog/Datadog SDKs and offers
to paste a read-only key for each one it finds (saved to `~/.ultimatehuman/engine.env`, 0600; the
config only holds `${ENV}` refs), asks for a staging URL, and ends on your setup grade plus a
**pending** list of what you skipped. Nothing is required past a repo and Claude Code: with no
error tracker at all it offers to write a minimal Sentry init on a new branch of your repo.
Add a skipped key later with `ultimatehuman key <ENV_NAME>`; the engine picks it up within a minute.
Then:

```sh
node packages/cli/dist/cli.mjs dashboard          # one-time login link to the local dashboard
node packages/cli/dist/cli.mjs service install    # keep it running (systemd / launchd), daily pass at 07:00
node packages/cli/dist/cli.mjs ci install         # optional: the PR review check, see docs/ci-check.md
```

(`npx ultimatehuman init` once the package is published.)

## Configure

One file, `~/.ultimatehuman/config.json5` (see `config.example.json5`), editable by hand or in the dashboard's **Config** page:

- **`repos`**: the local checkouts the agents read, `[{ name, path, testUrl?, notes? }]`. Each repo keeps its own git/GitHub auth; every finding carries a repo badge.
- **`models`**: one model per leg type (radar, review, retrospective, and the future fix/exam/chat/intake/bundle legs). Default `claude-opus-5-5`; Config > Models has a dropdown per leg.
- **`features`**: everything optional, every flag off by default, and off behaves exactly like a build without the feature. First real toggle: `validationGate` (new findings wait in *Awaiting validation* until you promote them).
- **Setup grade**: Bronze to Platinum, computed from the config, with "what unlocks the next tier" in Config > Setup grade. Spec: [docs/setup-grade.md](docs/setup-grade.md).

## What you need

- **Node 22+** (bootstrap installs it)
- **A Claude Code login** on the machine. An API key works too, for extra capacity.
- **Sources (optional, one is enough):** PostHog, Datadog (error logs + error events, read-only Application key: `logs_read_data`, `logs_read_index_data`, `events_read`; site `datadoghq.com` or `datadoghq.eu`), Sentry (plugin probe still a stub in this build).
- **Optional:** a GitHub token for issue previews. The pipeline keeps its own tickets without it.

## Plays nice with your own Claude usage

ultimatehuman shares your Claude subscription with you, so it is careful with it:

- **It checks first.** It looks at how much of your usage window is left before it starts any work.
- **It keeps a reserve for you.** By default it never touches the last 30% of the window.
- **It waits instead of failing.** When the window runs out, it saves its progress and resumes at the reset.
- **It shows where you stand.** The dashboard always tells you: `window 78% used · resets 17:00 · 3 items queued`.

## Let your AI install it

Paste this into Claude Code: *"Install ultimatehuman following docs/agent-install.md from <repo url>"*. That document is written for agents. Every step is non-interactive, has a verification check, and comes with a rollback.

## Status

Pre-alpha. The design lives in [SPEC.md](SPEC.md) and the build plan in [ROADMAP.md](ROADMAP.md).

## License

Apache-2.0 (proposed).
