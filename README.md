# ultimatehuman

**A local engineering review workspace. Connect a Git repository, discover useful investigations, and review findings with their evidence before deciding what deserves action.**

## Kill AI slop: the AI can look, never touch

Most AI dev tools write code nobody asked for and claim it works. ultimatehuman starts from the opposite end:

- **Read-only access.** It connects to your trackers with read-only credentials.
- **Explicit decisions.** Accept, dismiss with a reason, or set a finding aside. Accepted findings stay local; export a Markdown issue draft for your team. Live issue publishing is not implemented in this build.
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
config; from then on you configure repository scope, sources, schedules, and guidelines through
**Chat**, the CLI, or the config file. Any tool can also enqueue a ticket with `POST /api/findings`
(`docs/tickets-api.md`).

## Quick start

From a fresh machine (macOS or Linux, no Node needed):

```sh
git clone https://github.com/vincent38wargnier/ultimatehuman.git && cd ultimatehuman
bash scripts/bootstrap.sh      # Node 22 via nvm if missing -> pnpm -> install -> build -> init
```

`bootstrap.sh` is idempotent and never uses sudo (`--no-init` stops after the build).
The default CLI detects Claude Code and verifies the existing AI account with a small model request
**before asking for repositories or integrations**. It opens one shared setup conversation in the browser.
Claude asks for a Git repository, inspects its tracked files, identifies test tooling and tracking SDKs,
and suggests the existing pipeline templates. It asks one question at a time and applies configuration
through the engine's validated handlers. The installation directory is context, not an automatically added repository.

For an existing development checkout:

```sh
npx --yes pnpm@11.10.0 install
npx --yes pnpm@11.10.0 build
node packages/cli/dist/cli.mjs
```

The browser has four destinations:

- **Chat**: setup and configuration, using your existing Claude CLI account. Repository discovery,
  source verification, pipeline creation and runs, schedules, and versioned guideline edits happen here.
- **Setup**: project progress, connected repositories, tracking suggestions, and pipeline readiness.
  Each next step opens chat with the project context.
- **Pipeline live**: the original system overview, with queued work, active agents, evidence checks,
  blockers, and human decisions.
- **Review**: the original cockpit for inspecting evidence and validating or rejecting findings.

The chat composer lists models from your installed Claude Code, with Opus 5.5 selected by default.
Changing it affects new chat messages only; pipeline models keep their saved settings.

Pipeline defaults are unchanged: Security check runs daily at 06:30 with up to three findings;
Bug radar runs daily at 07:00 with up to five. Existing scopes, sources, schedules, models, and limits
are preserved unless you ask to change them. Without tracking, a repository-only Security check is available.
SDK detection is separate from verified source access. Chat can install instrumentation when requested;
native shell and file-edit approvals appear inside the conversation.

If the existing Claude session has expired, run `claude auth login` in a terminal and use **Check connection**.
Keys are saved through `ultimatehuman key ENV_NAME`, never pasted into chat. The **Connect Telegram** button
verifies a bot token and provides a private pairing link. Telegram, browser chat, and the CLI share one conversation.

```sh
node packages/cli/dist/cli.mjs --repos ~/code/my-project --no-open
node packages/cli/dist/cli.mjs --repos https://github.com/team/project --no-open
node packages/cli/dist/cli.mjs --no-open          # continue setup in terminal chat
node packages/cli/dist/cli.mjs chat               # resume the shared conversation
node packages/cli/dist/cli.mjs init --advanced    # retain the original terminal setup wizard
```

Run the default command again to resume the same workspace and conversation. Then:

```sh
node packages/cli/dist/cli.mjs dashboard          # one-time login link to the local dashboard
node packages/cli/dist/cli.mjs service install    # keep the engine running (systemd / launchd)
node packages/cli/dist/cli.mjs ci install         # optional: the PR review check, see docs/ci-check.md
```

The CLI package includes the built dashboard and has no workspace runtime dependencies.
`npx ultimatehuman@latest` is the intended entry point once the package is published.
Local development does not publish or install an OS service automatically.

To keep a local preview separate from your regular configuration:

```sh
ULTIMATEHUMAN_HOME=/tmp/ultimatehuman-preview \
ULTIMATEHUMAN_CONFIG=/tmp/ultimatehuman-preview/config.json5 \
node packages/cli/dist/cli.mjs --repos "$PWD" --port 4750
```

### Verification

```sh
npx --yes pnpm@11.10.0 typecheck
npx --yes pnpm@11.10.0 build
node scripts/workspace-check.mjs
node scripts/chat-check.mjs
```

The integration check exercises fresh and repeat CLI launches, existing-account verification,
expired-session recovery without resetting setup, project isolation, real runtime progress,
live flow states, decisions, version conflicts, concurrent configuration writes, bundled assets, and
timezone scheduling. Chat checks cover initialization, shared Claude sessions, actual configuration
operations, original template defaults, guideline conflicts, and private Telegram pairing. They use
temporary Git repositories, a deterministic model fixture, and a local Telegram stub;
they make no paid model calls or external issue writes. `UH_KEEP_FIXTURE=1` retains isolated engines for browser testing.

## Configure

One file, `~/.ultimatehuman/config.json5` (see `config.example.json5`), editable by hand or through **Chat**:

- **`repos`**: local checkouts, `[{ name, path, project?, issueRepo?, testUrl?, notes? }]`. Group related repositories into a project. Each pipeline keeps an explicit `repos` scope; legacy pipelines without one retain their existing workspace scope.
- **`models`**: per-stage models, including investigation, evidence review, retrospective, and chat.
- **`pipelines`**: objectives, source selection, repository scope, schedule, and timezone. Versioned guidelines supply each pipeline's detailed investigation rules.
- **Full configuration**: the engine's existing schema, features, models, and defaults remain available through chat and the CLI. Old configuration URLs open chat. Pipeline live and the original cockpit keep their original URLs.

## What you need

- **Node 22+** (bootstrap installs it)
- **A Claude Code login** on the machine. An API key works too, for extra capacity.
- **Sources (optional, one is enough):** PostHog, Datadog (error logs + error events, read-only Application key: `logs_read_data`, `logs_read_index_data`, `events_read`; site `datadoghq.com` or `datadoghq.eu`), Sentry (plugin probe still a stub in this build).
- **No GitHub token required:** findings and issue drafts are local. Connecting a private repository uses your existing Git authentication.

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
