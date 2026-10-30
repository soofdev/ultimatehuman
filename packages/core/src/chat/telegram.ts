import type { Config } from "../config/schema";
import { resolveSecretRefs, type SecretRefValue } from "../config/load";
import type { Store } from "../store/store";
import type { Chat } from "./chat";

/**
 * Telegram door of the setup chat (config `chat.telegram`, off by default).
 * Long-polls getUpdates; the first chat that writes is bound (kv) and every
 * other chat is ignored. Its messages join the same turn queue as the other
 * doors; the reply goes back with sendMessage. The API base is configurable so
 * a local stub can stand in for api.telegram.org.
 */
export class ChatTelegram {
  private stopped = false;
  private abort = new AbortController();

  constructor(
    private d: { store: Store; chat: Chat; getConfig: () => Config; configPath: string; log: (m: string) => void },
  ) {}

  start(): void {
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
  }

  private async call(base: string, token: string, method: string, body: unknown, timeoutMs: number): Promise<any> {
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(timeoutMs)]);
    const r = await fetch(`${base.replace(/\/+$/, "")}/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    const j = (await r.json().catch(() => ({}))) as any;
    if (!r.ok || j.ok === false) throw new Error(`${method}: ${j.description ?? `HTTP ${r.status}`}`);
    return j.result;
  }

  private async loop(): Promise<void> {
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let lastErr = "";
    while (!this.stopped) {
      const tg = this.d.getConfig().chat?.telegram;
      if (!tg?.enabled || !tg.botToken) {
        await pause(3000);
        continue;
      }
      try {
        const token = await resolveSecretRefs(tg.botToken as SecretRefValue, this.d.configPath);
        const offset = this.d.store.getKv<number>("chat.telegram.offset") ?? 0;
        const updates = (await this.call(tg.apiBase, token, "getUpdates", { offset, timeout: 25, allowed_updates: ["message"] }, 35_000)) as any[];
        lastErr = "";
        for (const u of updates) {
          this.d.store.setKv("chat.telegram.offset", u.update_id + 1);
          const m = u.message;
          if (!m?.chat?.id || typeof m.text !== "string") continue;
          let bound = this.d.store.getKv<number>("chat.telegram.chatId");
          if (bound === undefined) {
            bound = m.chat.id as number;
            this.d.store.setKv("chat.telegram.chatId", bound);
            this.d.log(`chat telegram: bound to chat ${bound}`);
          }
          if (m.chat.id !== bound) {
            this.d.log(`chat telegram: ignored a message from unbound chat ${m.chat.id}`);
            continue;
          }
          const chatId = bound;
          const { reply } = this.d.chat.send(m.text, "telegram");
          void reply
            .then(async (msg) => {
              // Telegram caps a message at 4096 characters.
              for (let i = 0; i < msg.text.length; i += 4000) await this.call(tg.apiBase, token, "sendMessage", { chat_id: chatId, text: msg.text.slice(i, i + 4000) }, 15_000);
            })
            .catch((e) => this.d.log(`chat telegram: reply not sent: ${(e as Error).message}`));
        }
      } catch (e) {
        if (this.stopped) break;
        const msg = (e as Error).message;
        if (msg !== lastErr) this.d.log(`chat telegram: ${msg}`);
        lastErr = msg;
        await pause(5000);
      }
    }
  }
}
