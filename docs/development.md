# Development and configuration

For normal installation, use `npx ultimatehuman@latest`. This guide is for working on the repository or running a separate local preview.

## Run from source

Requires Node.js 22.13+ and Git.

```sh
git clone https://github.com/vincent38wargnier/ultimatehuman.git
cd ultimatehuman
npx --yes pnpm@11.10.0 install --frozen-lockfile
npx --yes pnpm@11.10.0 build
node packages/cli/dist/cli.mjs
```

Alternatively, `bash scripts/bootstrap.sh` installs missing Node through nvm, installs dependencies, builds, and starts onboarding. It does not use sudo. Pass `--no-init` to stop after building.

The CLI bundle includes the dashboard and all runtime JavaScript dependencies. Its workspace packages are build inputs, not packages end users need to install.

## Isolated preview

```sh
ULTIMATEHUMAN_HOME=/tmp/ultimatehuman-preview \
ULTIMATEHUMAN_CONFIG=/tmp/ultimatehuman-preview/config.json5 \
node packages/cli/dist/cli.mjs --port 4750
```

The installation directory is context; it is not automatically registered as a project. Connect repositories in chat, or pass `--repos <path-or-url,path-or-url>`.

## Verification

```sh
npx --yes pnpm@11.10.0 -r --filter './packages/**' typecheck
npx --yes pnpm@11.10.0 build
node scripts/workspace-check.mjs
node scripts/chat-check.mjs
npx --yes pnpm@11.10.0 exec esbuild scripts/datadog-mapping-check.ts --bundle --platform=node --format=esm --outfile=/tmp/ultimatehuman-datadog-check.mjs
node /tmp/ultimatehuman-datadog-check.mjs
```

These checks use temporary repositories, deterministic model responses, and local source/Telegram fixtures. They do not make paid model calls or publish issues. `UH_KEEP_FIXTURE=1` retains a test engine for browser inspection.

See [releasing](releasing.md) for package preparation and clean-install checks.

## Configuration

`~/.ultimatehuman/config.json5` holds the configuration. Chat applies changes through validated engine handlers. You can also use the CLI or edit the file; [config.example.json5](../config.example.json5) documents the schema.

| Setting | Purpose |
| --- | --- |
| `repos` | Local checkouts, project grouping, test URLs, and repository notes |
| `pipelines` | Objectives, source selection, repository scope, schedule, timezone, and overrides |
| `models` | Separate models for investigation, review, retrospective, and chat |
| Versioned guidelines | Detailed investigation rules with history and restore support |

Existing pipelines keep their saved scope and settings. Installing a template copies its defaults; it does not overwrite existing pipelines. The default reserve is 30% of account capacity.

## Other entry points

```sh
node packages/cli/dist/cli.mjs --no-open
node packages/cli/dist/cli.mjs chat
node packages/cli/dist/cli.mjs init --advanced
node packages/cli/dist/cli.mjs dashboard
node packages/cli/dist/cli.mjs service install
node packages/cli/dist/cli.mjs ci install
```

`--no-open` keeps an interactive installation in terminal chat. `init --advanced` retains the original setup wizard. `dashboard` prints a single-use local login link. `service install` configures launchd or a systemd user service. [The optional CI check](ci-check.md) installs the PR review workflow into a repository without committing it.

Source credentials normally go through the connection form in chat. For terminal-only operation, `ultimatehuman key ENV_NAME` prompts for a value without echoing it. If Claude access needs renewal, use `claude auth login`, then check the connection again.

## Reference

- [Chat and shared sessions](chat.md)
- [Pipelines and original defaults](pipelines.md)
- [Findings API](tickets-api.md)
- [Product concept and workflow](concept-and-pipeline.md)
- [Architecture specification](../SPEC.md)
