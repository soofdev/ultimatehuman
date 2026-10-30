# Setup chat

One conversation with this install's setup assistant, reachable from three doors:

- **Dashboard**: the Chat page (sidebar).
- **CLI**: `ultimatehuman chat` (REPL; prints the last 10 messages first) or `ultimatehuman chat "<message>"` (one shot).
- **Telegram** (optional, off by default): `chat.telegram` in the config.

Every message is stored in the `chat` table of the engine's SQLite store with its door (`dashboard`, `cli`, `telegram`), so each door shows the same history with a source tag.

## How a turn runs

Each user message is one `claude -p` turn that resumes the session id kept in the kv store (`chat.session`). It has no shell: only Read and Glob, plus Write scoped to `chat/outbox/` by an `Edit(path)` rule. `--resume` keeps the system prompt the session started with, so when the chat's system prompt changes (its hash is kept in `chat.session.prompt`) the next turn starts a fresh session; the stored history is untouched. Turns are serialized: one runs at a time whatever the door, the others wait in order. The model is `models.chat` (default `claude-opus-5-5`).

Each turn carries the current config file. To change it, the agent ends its reply with a fenced `config-patch` JSON block; the engine deep-merges it into the file (objects merge, values and arrays replace, `null` deletes), validates it and writes it through the same path as the Config page. The block is replaced in the reply by `✅ Config updated: <paths>` or `⚠️ Config change refused: <why>`.

## Images and files

The same conventions as the Telegram -> Claude Code bridge (`vince_assistant/bot.py`):

- **In**: an attached image is saved to `<home>/chat/inbox/<unix seconds>_<name>` and the message gets one line per file, `[user sent a photo, saved at /abs/path]` (Telegram documents: `[user sent a document, ...]`). The agent Reads it. The dashboard composer takes images by the attach button, drag-drop or paste (max 4, 10 MB each); Telegram photos (largest size) and documents are fetched with `getFile`.
- **Out**: the agent puts `[[send:/absolute/path]]` on its own line. Each door strips the tag: the dashboard shows the image inline (click = full size), Telegram sends it with `sendPhoto` (png/jpg/webp) or `sendDocument`, the CLI prints `[file] <path>`. New images go to `<home>/chat/outbox/` (the only place the agent can write; SVG works since it is text).
- **Guard**: `GET /api/chat/file?path=` serves images only, and only from inside the install home or a configured repo (symlinks resolved first); Telegram applies the same check before sending. SVGs are served with `nosniff` and a sandboxing CSP.

## Telegram

```json5
chat: {
  telegram: {
    enabled: true,
    botToken: '${UH_CHAT_BOT_TOKEN}', // a ${ENV_VAR} ref, never the token
    // apiBase: 'https://api.telegram.org', // point at a local stub to test
  },
},
```

Use a bot of its own (Telegram allows one `getUpdates` poller per bot, so not the notifications bot if something else polls it). The first chat that writes to the bot is bound (`chat.telegram.chatId` in kv) and every other chat is ignored. Turning it on counts toward Silver's notifications check in the setup grade.

HTTP: `GET /api/chat` returns `{ messages, busy }`; `POST /api/chat { text, files?: [{ name, data: base64 }], source?: "cli", wait?: true }` queues a turn (202), or with `wait` returns the reply.
