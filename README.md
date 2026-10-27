# ultimatehuman

**A self-hosted bug radar: it reads your Sentry and PostHog, finds the real product problems behind the noise, and files evidence-rich GitHub issues. Then a human takes it from there.**

## Kill AI slop: the AI can look, never touch

Most AI dev tools write code nobody asked for and claim it works. ultimatehuman starts from the opposite end:

- **Read-only access.** It connects to your trackers with read-only credentials.
- **Issues only.** The one thing it writes is an issue in a single repo you choose.
- **Evidence or nothing.** Every finding cites real events with links you can click, and it says plainly what is not known yet. "No clear problems found" is a valid answer; it never pads a list.
- **Fixes prove themselves (planned).** When fixes arrive in v2, they come as pull requests that must reproduce the bug and then prove the fix in a real browser on your test environment, examined like a hostile reviewer would.
- **Humans stay in charge.** A human merges, and a human deploys.

## Install (aspirational, not published yet)

```sh
npx ultimatehuman init
```

## Quick start

```sh
npx ultimatehuman init         # finds your keys, checks each one live, starts the first radar pass
npx ultimatehuman dashboard    # prints a one-time login link to the local dashboard
npx ultimatehuman service install   # keep it running (systemd / launchd), daily pass at 07:00
```

## What you need

- **Node 22+**
- **A Claude Code login** on the machine. An API key works too, for extra capacity.
- **At least one source:** Sentry or PostHog. Datadog is coming next.
- **A GitHub fine-grained token** for one repo: Issues read/write, Contents read-only.

## Plays nice with your own Claude usage

ultimatehuman shares your Claude subscription with you, so it is careful with it:

- **It checks first.** It looks at how much of your usage window is left before it starts any work.
- **It keeps a reserve for you.** By default it never touches the last 30% of the window.
- **It waits instead of failing.** When the window runs out, it saves its progress and resumes at the reset.
- **It shows where you stand.** The dashboard always tells you: `window 78% used · resets 17:00 · 3 items queued`.

## Let your AI install it

Paste this into Claude Code: *"Install ultimatehuman following docs/agent-install.md from <repo url>"*. That document is written for agents. Every step is non-interactive, has a verification check, and comes with a rollback.

## Status

Pre-alpha. The design lives in [SPEC.md](SPEC.md) and the build plan in [ROADMAP.md](ROADMAP.md). The packages are typed stubs: they compile, but they do not do anything yet.

## License

Apache-2.0 (proposed).
