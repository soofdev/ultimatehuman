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

## Contribution rights

The public project uses the custom [ultimatehuman Community License 1.0](LICENSE): PolyForm Noncommercial 1.0.0 with an additional small-business permission. The owner also offers separate commercial licenses. See [LICENSING.md](LICENSING.md).

Before merging code or other copyrightable material from an external contributor, the maintainer must obtain a separate written contributor agreement granting the rights needed to distribute and sublicense that contribution under both the public license and commercial terms. A pull request alone is not that agreement and does not transfer copyright. Do not merge external contributions until the necessary rights are documented.

Bug reports and feature suggestions are welcome without a contributor agreement. Do not include third-party code unless its origin and license are documented.
