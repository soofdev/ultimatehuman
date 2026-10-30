# Setup chat

One conversation with this install's setup assistant, reachable from three doors:

- **Dashboard**: the Chat page (sidebar).
- **CLI**: `ultimatehuman chat` (REPL; prints the last 10 messages first) or `ultimatehuman chat "<message>"` (one shot).
- **Telegram** (optional, off by default): `chat.telegram` in the config.

Every message is stored in the `chat` table of the engine's SQLite store with its door (`dashboard`, `cli`, `telegram`), so each door shows the same history with a source tag.

## How a turn runs

Each user message is one `claude -p` turn that resumes the session id kept in the kv store (`chat.session`), with no file or shell tools. Turns are serialized: one runs at a time whatever the door, the others wait in order. The model is `models.chat` (default `claude-opus-5-5`).

Each turn carries the current config file. To change it, the agent ends its reply with a fenced `config-patch` JSON block; the engine deep-merges it into the file (objects merge, values and arrays replace, `null` deletes), validates it and writes it through the same path as the Config page. The block is replaced in the reply by `✅ Config updated: <paths>` or `⚠️ Config change refused: <why>`.

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

HTTP: `GET /api/chat` returns `{ messages, busy }`; `POST /api/chat { text, source?: "cli", wait?: true }` queues a turn (202), or with `wait` returns the reply.
