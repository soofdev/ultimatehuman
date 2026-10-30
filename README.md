# ultimatehuman

**A self-hosted bug radar: it reads your Sentry and PostHog, finds the real product problems behind the noise, and files evidence-rich GitHub issues. Then a human takes it from there.**

## Kill AI slop: the AI can look, never touch

Most AI dev tools write code nobody asked for and claim it works. ultimatehuman starts from the opposite end:

- **Read-only access.** It connects to your trackers with read-only credentials.
- **Issues only.** The one thing it writes is an issue in a single repo you choose.
- **Evidence or nothing.** Every finding cites real events with links you can click, and it says plainly what is not known yet. "No clear problems found" is a valid answer; it never pads a list.
- **Fixes prove themselves (planned).** When fixes arrive in v2, they come as pull requests that must reproduce the bug and then prove the fix in a real browser on your test environment, examined like a hostile reviewer would.
- **Humans stay in charge.** A human merges, and a human deploys.

## Quick start

From a fresh machine (macOS or Linux, no Node needed):

```sh
git clone https://github.com/vincent38wargnier/ultimatehuman.git && cd ultimatehuman
bash scripts/bootstrap.sh      # Node 22 via nvm if missing -> pnpm -> install -> build -> init
```

`bootstrap.sh` is idempotent and never uses sudo (`--no-init` stops after the build). Then:

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
- **At least one source:** Sentry or PostHog. Datadog is coming next.
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
