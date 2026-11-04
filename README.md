<p align="center">
  <img src="docs/assets/hero.svg" alt="ultimatehuman — AI investigates. You decide." width="100%" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/ultimatehuman"><img src="https://img.shields.io/npm/v/ultimatehuman?color=d3ff5f&labelColor=152018" alt="npm version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-d3ff5f?labelColor=152018" alt="Apache 2.0 license" /></a>
  <a href="https://github.com/vincent38wargnier/ultimatehuman/actions/workflows/check.yml"><img src="https://github.com/vincent38wargnier/ultimatehuman/actions/workflows/check.yml/badge.svg" alt="Build and package checks" /></a>
</p>

**Your production data already tells you where the product is breaking. ultimatehuman connects it to your code and brings you the investigation, the evidence, and a decision.**

Run it on your machine. Set it up through chat. Watch the pipeline work. Review what deserves action.

## Start here

```sh
npx ultimatehuman@latest
```

Requires **macOS or Linux**, **Node.js 22.13+**, **Git**, and **Claude Code installed and signed in**. [Install Node.js](https://nodejs.org/en/download) · [Set up Claude Code](https://code.claude.com/docs/en/quickstart)

The CLI verifies your existing Claude account, starts the local engine, and opens your browser. **Continue in Chat.** Chat and investigations use your configured Claude Code account and count toward its usage limits.

Start with something like:

> My project is Acme. The frontend is in ~/code/acme-web and the API is in ~/code/acme-api. Help me set up the first pipeline.

1. **Connect the project.** Chat inspects your repositories and identifies frameworks, tests, and tracking tools.
2. **Connect the signals.** If you already use PostHog or Datadog, connect it through a private credential form inside chat. No tracking yet? Start with a code-only Security check, or ask for help adding tracking.
3. **Run one pipeline.** Review its scope and schedule, then ask it to run. Follow the investigation in **Pipeline live**.
4. **Make the decision.** Open a finding in **Review**, inspect its evidence, and accept, dismiss, or set it aside.

Run the same command again to reopen your workspace. Your repositories, settings, and conversation are preserved.

## Less chasing. More deciding.

A log is a symptom. A replay is a clue. A repository explains how the failure could happen. Putting those pieces together is the work.

ultimatehuman runs that investigation for you: it groups signals, reads the relevant code, challenges the explanation, and checks the evidence before a finding reaches your review queue. If the evidence does not hold up, the pipeline can finish without a finding.

**The AI does not approve its own work. You make the decision.**

<p align="center">
  <img src="docs/assets/pipeline.svg" alt="Production signals and repository code flow through investigation and evidence checks to a human review." width="100%" />
</p>

## One conversation. The whole system in view.

| Workspace | What you do there |
| --- | --- |
| **Chat** | Connect repositories and sources, create pipelines, set schedules, and change guidelines in plain language. |
| **Setup** | See which repositories are wired, which sources are connected, and what to set up next. |
| **Pipeline live** | Follow queued work, active investigations, evidence checks, blockers, and decisions across the system. |
| **Review** | Read the problem, impact, and supporting evidence. Record your decision and export an issue draft. |

The browser, terminal, and optional Telegram connection share one conversation. Chat offers the models available in your installed Claude Code, with **Opus 5.5** as its default. Changing the chat model leaves pipeline models unchanged.

## Start with the tools you already use

| Input | What it unlocks today |
| --- | --- |
| **PostHog** | Investigate errors and user behavior with event and session evidence. |
| **Datadog** | Investigate recurring failures using error logs and events. |
| **Git repositories** | Connect a finding to its code; investigate security risks without a tracker. |
| **Findings API** | Submit a finding from another tool into the same review workflow. |

Detection is not connection: finding an SDK in your repository does not grant access to its data. Chat opens a credential form, provides setup guidance, and checks access before treating a source as connected. Keys are saved on your machine, outside the chat transcript.

Two pipeline templates are included. You can change their scope, schedule, timezone, models, and guidelines through chat.

| Pipeline | Investigates | Default schedule | Findings per run |
| --- | --- | --- | --- |
| **Bug radar** | User-facing bugs from connected tracking data | Daily, 07:00 | Up to 5; at least 2 evidence items |
| **Security check** | Exposed secrets, dependencies, and authentication/authorization patterns | Daily, 06:30 | Up to 3; at least 1 evidence item |

Schedules use the engine's timezone unless you specify one. These are limits, not quotas. A quiet or inconclusive investigation may produce no tickets.

## Your machine. Your account. Your judgment.

- **Local workspace.** The engine, dashboard, configuration, and findings run on your machine. Relevant code and evidence are sent to your configured AI provider during analysis; connected sources are queried over their APIs.
- **Read-only investigations.** Autonomous pipelines inspect sources and code. Interactive chat can run shell commands or edit files with approvals shown in the conversation.
- **Capacity for your own work.** The engine reserves 30% of the account's usage window by default and can pause work when capacity is exhausted.
- **Explicit outcomes.** Accepting a finding records your decision locally. You can export a Markdown issue draft; acceptance does not merge or deploy code.

## Where this is going

The goal is autonomous engineering with a human decision at its center:

**Discover → Plan → Fix and test → Human decision → Verify**

This first public release delivers the **investigation and review** part: chat setup, real source connections, scheduled pipelines, evidence checks, live progress, and local decisions.

Autonomous fixes, browser proof of a fix, pull-request delivery, and deployed verification are the next stages. Sentry collection, automatic database preparation, and direct issue publishing are also not included in this release. [Read the pipeline concept](docs/concept-and-pipeline.md) · [See the roadmap](ROADMAP.md)

## A few useful commands

| Command | Purpose |
| --- | --- |
| `npx ultimatehuman@latest` | Start or reopen the browser workspace |
| `npx ultimatehuman@latest chat` | Continue the shared conversation in your terminal |
| `npx ultimatehuman@latest doctor` | Check account access and configuration |
| `npx ultimatehuman@latest service install` | Keep the engine running after login/restart |
| `npx ultimatehuman@latest stop` | Stop an engine launched without the background service |

Prefer a persistent command? Run `npm install -g ultimatehuman`, then `ultimatehuman`.

### Questions

**Do I need a separate API key for Claude?** No. The normal installation uses your existing Claude Code login. Tracker credentials are separate and are requested only when connecting a source.

**Can one project include several repositories?** Yes. Tell chat which repositories belong together, such as your frontend and API.

**Do I need PostHog or Datadog?** No. The Security check works from repository code. Production bug investigations need a connected source with relevant data.

**Does it run while my laptop is closed?** The machine must be awake and online. Use an always-on machine for continuous operation. The optional background service handles restarts, not sleep.

**Where is my data?** In `~/.ultimatehuman` by default. Use `ULTIMATEHUMAN_HOME` to select another workspace. [Configuration and development](docs/development.md)

## Build with us

This is an early open-source release. Useful bug reports include the installed version, the steps you took, and what you expected. Remove credentials and private project data before posting.

[Report a problem](https://github.com/vincent38wargnier/ultimatehuman/issues) · [Contribute](CONTRIBUTING.md) · [Run from source](docs/development.md) · [Agent installation guide](docs/agent-install.md)

Licensed under [Apache 2.0](LICENSE).
