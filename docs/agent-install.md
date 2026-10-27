# Installing ultimatehuman (instructions for an AI coding agent)

> Status: outline. Commands below describe the target CLI; they are not published yet.

You are installing ultimatehuman on the human's machine. Follow every step in order. Run each verification and stop if it fails; report the exact output to the human.

## Hard rules for you
- Never write a secret value into any file. Config holds `${ENV_VAR}` references only.
- Never create or widen tokens yourself. If a key is missing, ask the human, and give them the exact help link printed by `ultimatehuman init --list-fields`.
- Never run as root. Never bind the dashboard to a non-loopback address.
- Never paste a dashboard login link anywhere except back to the human.

## 1. Preconditions
```sh
node --version                # must be >= 22
claude --version && claude -p "Reply with exactly: ok" --max-turns 1   # Claude login works
```

## 2. Discover keys
```sh
npx ultimatehuman init --detect --json
```
This lists each source and the env vars found. For anything listed as `missing`, ask the human for it, and pass on the `helpUrl` and `helpText` from that output.

## 3. Initialize non-interactively
```sh
npx ultimatehuman init --non-interactive --json \
  --auth claude-login \
  --sentry-token-env SENTRY_AUTH_TOKEN \
  --posthog-key-env POSTHOG_PERSONAL_API_KEY \
  --github-repo OWNER/REPO --github-token-env GITHUB_TOKEN
```
- Exit code 2 means a required value is missing. The JSON names the missing flag.

## 4. Verify
```sh
npx ultimatehuman doctor --json      # every check must have "ok": true
curl -fsS http://127.0.0.1:4747/api/health
```

## 5. Keep it running (optional, ask the human first)
```sh
npx ultimatehuman service install && npx ultimatehuman service status
```

## 6. Hand over
```sh
npx ultimatehuman dashboard          # prints a single-use login link, valid 10 minutes
```
Give the link to the human. Tell them the first radar pass is already running.

## Rollback
```sh
npx ultimatehuman service uninstall
# Only after the human confirms:
rm -rf ~/.ultimatehuman
```
