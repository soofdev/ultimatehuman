# Chat

One conversation, using the installation's existing Claude CLI account:

- **Browser:** Chat, next to Setup, Pipeline live and Review.
- **CLI:** `ultimatehuman chat`, or `ultimatehuman chat "<message>"` for one request.
- **Telegram:** Connect Telegram in Chat, or `ultimatehuman telegram` after saving a bot token.

Messages are stored locally with their channel (`dashboard`, `cli`, or `telegram`). All channels
share the same serialized turn queue and Claude session. Attachments and history are preserved.

## Initialization

The default command and `ultimatehuman init` verify Claude access, start the engine, and open chat.
An existing login is reused. An expired login is reported accurately; interactive installation can
launch `claude auth login`. `--no-open` continues in terminal chat. `init --advanced` keeps the original wizard.

Claude asks which project to start with and which repositories belong to it, then calls the engine's repository discovery handler. Discovery reads
tracked files without executing project code. The terminal's working directory is only context until the
user chooses a repository. A detected tracking SDK is not treated as a verified data connection.

Claude recommends a supported tracker already detected in the project, connects it in chat, and starts
one Bug radar before suggesting more pipelines. A repo-only Security check is an alternative when no
supported tracking exists or the user requests code review. Original template schedules, limits, models,
and existing scope are preserved. Tracker instrumentation can be installed with native Claude tools;
shell and file-edit permission requests appear in chat.

`POST /api/chat/start` initializes an empty conversation once. Reopening the browser or CLI does not
restart onboarding or replace the existing configuration.

## Setup overview

`/setup` shows each project's connected repositories, pipeline wiring, account readiness, and first
completed run. Pipeline suggestions come from the existing templates; saved pipelines and their
defaults are preserved. An SDK detected in a repository is separate from verified workspace read
access. PostHog and Datadog suggestions link to their official setup docs and carry the project back
into chat. Unsupported collectors remain explicitly labeled. A run without a readable source does
not complete the first-run milestone, and code-only reviews do not require tracking.

## Chat model

The composer defaults to **Opus 5.5** and lists models returned by the installed Claude Code CLI's
initialization response. This uses the same account environment as chat and sends no inference
prompt. Aliases are resolved and deduplicated; the list is cached for five minutes. Failed discovery
keeps the selected model and offers a retry instead of inventing available models.

Selecting a model saves only `models.chat`. Each message captures the selected model when queued;
an active turn and its follow-up operations keep their model. Browser, CLI, and Telegram share the
selection and conversation. Pipeline stage models and per-pipeline overrides are unchanged.
The catalog fields follow the [Claude Agent SDK model metadata](https://code.claude.com/docs/en/agent-sdk/typescript#modelinfo).

## Engine operations

Each turn resumes `claude -p` with the current configuration, schema, templates, project discovery,
connector capabilities, and setup status. Interactive chat enables Claude's Read, Grep, Glob, Bash,
Edit, Write, WebSearch, and WebFetch tools. Its native permission protocol pauses shell/file operations
that require approval and displays the command or edit in the browser; terminal chat can approve them
too. Requests expire without granting permission. Autonomous investigation runners remain read-only.

The model can emit a fenced `config-patch` JSON object or a fenced `workspace-action` JSON object.
The engine validates and executes these, then supplies the actual result to Claude before its reply.
Operation blocks are not shown as the assistant's reply. A turn is bounded to five model rounds and
eight operations. Rejected operations do not mutate configuration.

Configuration patches use the existing serialized write path: objects merge, values and arrays replace,
and `null` removes a value. Arrays with `id` fields support patches by ID. Creating a pipeline from a
template retains its exact defaults. Secrets must be references, such as `${POSTHOG_PERSONAL_API_KEY}`;
enter their values in the connection form, never in the conversation. `ultimatehuman key ENV_NAME`
remains available for manual administration.

| Workspace action | Effect |
| --- | --- |
| `inspect_project` | Connect a local path or Git URL and discover tracked code |
| `status`, `check_account`, `activation` | Read actual readiness or verify Claude access |
| `request_connection` | Open a PostHog or Datadog credential form inside chat |
| `connect_source` | Resolve saved keys and verify supported source access |
| `investigate`, `run_pipeline` | Start work through the existing pipeline runtime |
| `get_guidelines` | Read briefs, current version, and history |
| `update_guidelines`, `restore_guidelines` | Apply a versioned edit with an `expectedVersion` check |
| `install_service` | Install the background service when explicitly requested |

A changed system-prompt hash starts a fresh Claude session and supplies recent conversation history.
The locally stored history remains intact. The model comes from `models.chat`.

## In-chat source connection

The form links to official key pages for the selected region/site and shows the connector's required
read scopes. Credentials are submitted directly to the authenticated engine. It checks access, requires
project selection when PostHog returns several projects, then saves keys in `engine.env` (`0600`). Only
references enter configuration; the connection result resumes the setup conversation without the keys.
Failed checks leave the request pending. Known credential formats pasted into chat are masked before
storage/model input; browser-pasted PostHog keys are moved into the form instead of the message.
This does not remove secrets already written to historical files by older releases.

## Telegram

Create a dedicated bot with [BotFather](https://t.me/BotFather). Use **Connect Telegram** to enter its
token, or save it in the terminal:

```sh
ultimatehuman key UH_CHAT_BOT_TOKEN
ultimatehuman telegram
```

The engine verifies the token with `getMe`, saves it in `engine.env` with mode `0600`, and keeps only
`${UH_CHAT_BOT_TOKEN}` in configuration. The token is never passed to Claude or stored in chat history.

Open the returned private link and press Start. The pairing code expires after ten minutes. Only a
private chat carrying the exact code can bind; other messages, groups, and other chats are ignored.
Once paired, its messages join the same conversation. Existing valid bindings survive reconnection.
The bot uses long polling; use a bot that no other application is polling.

## Images and files

- Incoming images are saved under `<home>/chat/inbox/` and referenced in the model's prompt. Browser
  chat supports attachment, drag-and-drop, and paste: up to four images, 10 MB each. Telegram also supports documents.
- Claude can return `[[send:/absolute/path]]` on its own line. Browser chat displays supported images;
  Telegram sends a photo or document; the CLI prints the path.
- Files can only be served or sent from the install home or a configured repository, after resolving
  symlinks. Browser file responses accept images only. SVGs have `nosniff` and a sandboxing CSP.

## HTTP

| Endpoint | Purpose |
| --- | --- |
| `GET /api/chat` | Messages, activity, pending connections and native tool approvals |
| `POST /api/chat` | Queue `{ text, files?, source?, wait? }`; `wait: true` returns the reply |
| `POST /api/chat/start` | Initialize an empty conversation once |
| `GET /api/chat/models` | Native CLI model catalog; `?refresh=1` reloads it |
| `POST /api/chat/model` | Save `{ model }` for new chat messages only |
| `GET /api/chat/connections` | Public form fields, scopes, and official key guides |
| `POST /api/chat/connections/request` | Create or reuse a pending connection form |
| `POST /api/chat/connections/:id` | Verify and save credentials, then continue chat |
| `POST /api/chat/permissions/:id` | Allow or decline one native Claude tool request |
| `GET /api/chat/telegram` | Connection status and current pairing link |
| `POST /api/chat/telegram/connect` | Verify `{ token? }` or reuse the saved token |

These endpoints require the existing local dashboard session or CLI control key. Browser mutations
use the existing CSRF protection. `node scripts/chat-check.mjs` exercises the real CLI, HTTP handlers,
store, and runtime with a local model fixture and Telegram stub.
