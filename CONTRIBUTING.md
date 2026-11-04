# Contributing

Start with a small, concrete change. For a substantial feature, open an issue describing the user problem and proposed behavior before building it.

## Work locally

Follow [the development guide](docs/development.md). Keep development instances separate with `ULTIMATEHUMAN_HOME`; do not run tests against your real configuration or credentials.

Before opening a pull request, build the project, run type checks, and run the relevant integration checks. Packaging changes also need `release:prepare` and `release:check`.

## Product principles

- Setup and configuration happen through chat. Keep the interface focused on setup progress, live operations, and human review.
- Preserve saved settings and the original pipeline/review workflows.
- Show evidence and uncertainty. Detection, connection, execution, and verification are different states.
- Keep autonomous investigations read-only. Show approvals for interactive shell commands and edits.
- Keep secrets out of chat transcripts, test fixtures, screenshots, and logs.

## Pull requests

Explain the user-visible behavior, the checks you ran, and any remaining limitations. Include screenshots for visual changes using sample data. Never include private project data or credentials.

By submitting a contribution, you agree that it is provided under this project's [Apache 2.0 license](LICENSE).
