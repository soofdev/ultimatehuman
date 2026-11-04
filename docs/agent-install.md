# Install ultimatehuman with an AI coding assistant

Use the published CLI and preserve any existing workspace. Setup continues through ultimatehuman's chat.

## Check the machine

```sh
node --version
git --version
claude --version
claude auth status
```

Use macOS or Linux and Node.js 22.13+. If Claude Code is missing or signed out, help the user complete [Claude Code setup](https://code.claude.com/docs/en/quickstart) before continuing. Do not copy account credentials into prompts or files.

## Start

```sh
npx --yes ultimatehuman@latest
```

The CLI verifies the configured account, starts the local engine, and opens a single-use browser login link. Continue in **Chat** and tell it which repositories belong to the first project. Do not claim that a pipeline is running until one has been created and started.

For a terminal-only session:

```sh
npx --yes ultimatehuman@latest --no-open
```

For an unattended launch without opening a browser:

```sh
npx --yes ultimatehuman@latest --non-interactive --no-open
```

Return the login link privately to the user. Re-running the default command preserves configuration and the conversation.

## Complete setup in chat

1. Group the project's repositories and inspect the detected tools.
2. Prefer a production investigation using an existing PostHog or Datadog installation. Use the in-chat connection form for keys. A detected SDK is not a verified connection.
3. If no tracking is available, offer a repository-only Security check or help adding tracking.
4. Explain the selected pipeline's scope, schedule, timezone, and limits before creating it. Apply the user's requested settings.
5. Start the first run and point the user to **Pipeline live**, then **Review** when a supported finding is ready.

Do not paste secrets into chat, change existing pipeline defaults without direction, or promise a finding from every run.

## Verify and resume

```sh
npx --yes ultimatehuman@latest --version
npx --yes ultimatehuman@latest doctor
npx --yes ultimatehuman@latest chat
```

Missing optional sources do not mean the installation failed. Inspect the actual account and configured-pipeline checks.

## Optional background operation

If the user wants ongoing operation, explain that the machine must remain awake and online, then use:

```sh
npx --yes ultimatehuman@latest service install
npx --yes ultimatehuman@latest service status
```

To stop a foreground/detached engine use `npx ultimatehuman@latest stop`. To remove a background service use `npx ultimatehuman@latest service uninstall`. Keep `~/.ultimatehuman` unless the user explicitly asks to delete their workspace.
