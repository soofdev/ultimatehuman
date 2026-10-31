import type { Config } from "../config/schema";
import { resolveSecretRefs, type SecretRefValue } from "../config/load";
import type { Store } from "../store/store";
import type { Chat } from "./chat";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { allowedFile, extractSends, fileType, PHOTO_TYPES, saveToInbox, sentNote } from "./files";

/**
 * Telegram door of the setup chat (config `chat.telegram`, off by default).
 * Long-polls getUpdates; the first chat that writes is bound (kv) and every
 * other chat is ignored. Its messages join the same turn queue as the other
 * doors; the reply goes back with sendMessage. Photos/documents are fetched with
 * getFile into the chat inbox and announced in the prompt like the bridge does;
 * `[[send:path]]` files in a reply go out with sendPhoto (sendDocument for
 * non-images). The API base is configurable so a local stub can stand in for
 * api.telegram.org.
 */
export class ChatTelegram {
  private stopped = false;
  private abort = new AbortController();

  constructor(
    private d: { store: Store; chat: Chat; home: string; chatRoots: () => string[]; getConfig: () => Config; configPath: string; log: (m: string) => void },
  ) {}

  start(): void {
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
  }

  /** Proactive message to the bound chat (no-op while the door is off or no chat is bound yet). */
  async push(text: string): Promise<boolean> {
    const tg = this.d.getConfig().chat?.telegram;
    const chatId = this.d.store.getKv<number>("chat.telegram.chatId");
    if (!tg?.enabled || !tg.botToken || chatId === undefined) return false;
    const token = await resolveSecretRefs(tg.botToken as SecretRefValue, this.d.configPath);
    await this.call(tg.apiBase, token, "sendMessage", { chat_id: chatId, text: text.slice(0, 4000) }, 15_000);
    return true;
  }

  private async call(base: string, token: string, method: string, body: unknown, timeoutMs: number): Promise<any> {
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(timeoutMs)]);
    const r = await fetch(`${base.replace(/\/+$/, "")}/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    const j = (await r.json().catch(() => ({}))) as any;
    if (!r.ok || j.ok === false) throw new Error(`${method}: ${j.description ?? `HTTP ${r.status}`}`);
    return j.result;
  }

  private async sendFile(base: string, token: string, chatId: number, path: string): Promise<void> {
    const type = fileType(path);
    const [method, field] = PHOTO_TYPES.has(type) ? ["sendPhoto", "photo"] : ["sendDocument", "document"];
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set(field, new Blob([await readFile(path)], { type }), basename(path));
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(120_000)]);
    const r = await fetch(`${base.replace(/\/+$/, "")}/bot${token}/${method}`, { method: "POST", body: form, signal });
    const j = (await r.json().catch(() => ({}))) as any;
    if (!r.ok || j.ok === false) throw new Error(`${method}: ${j.description ?? `HTTP ${r.status}`}`);
  }

  /** getFile, then the file URL, into the inbox. Returns the saved path or null. */
  private async download(base: string, token: string, fileId: string, name?: string): Promise<string | null> {
    try {
      const info = await this.call(base, token, "getFile", { file_id: fileId }, 15_000);
      const r = await fetch(`${base.replace(/\/+$/, "")}/file/bot${token}/${info.file_path}`, { signal: AbortSignal.timeout(120_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return saveToInbox(this.d.home, name ?? basename(String(info.file_path)), Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      this.d.log(`chat telegram: download failed: ${(e as Error).message}`);
      return null;
    }
  }

  /** The message text (or caption) plus one bridge-style line per attached photo/document. */
  private async prompt(base: string, token: string, m: any): Promise<string> {
    const files: [string, string, string | undefined][] = [];
    if (Array.isArray(m.photo) && m.photo.length) {
      const best = m.photo.reduce((a: any, b: any) => ((b.file_size ?? 0) > (a.file_size ?? 0) ? b : a));
      files.push(["photo", best.file_id, undefined]);
    }
    if (m.document?.file_id) files.push(["document", m.document.file_id, m.document.file_name]);
    let text = String(m.text ?? m.caption ?? "");
    for (const [kind, id, name] of files) {
      const path = await this.download(base, token, id, name);
      const note = path ? sentNote(kind, path) : `[user sent a ${kind} but the download failed]`;
      text = text ? `${text}\n${note}` : note;
    }
    return text;
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
          if (!m?.chat?.id || (typeof m.text !== "string" && !m.photo && !m.document)) continue;
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
          const text = await this.prompt(tg.apiBase, token, m);
          if (!text) continue;
          const { reply } = this.d.chat.send(text, "telegram");
          void reply
            .then(async (msg) => {
              const out = extractSends(msg.text);
              // Telegram caps a message at 4096 characters.
              for (let i = 0; i < out.text.length; i += 4000) await this.call(tg.apiBase, token, "sendMessage", { chat_id: chatId, text: out.text.slice(i, i + 4000) }, 15_000);
              for (const p of out.paths) {
                const ok = allowedFile(p, this.d.chatRoots());
                if (ok) await this.sendFile(tg.apiBase, token, chatId, ok).catch((e) => this.d.log(`chat telegram: file not sent: ${(e as Error).message}`));
                else await this.call(tg.apiBase, token, "sendMessage", { chat_id: chatId, text: `(file not sent: ${p} is missing or outside the install home and repos)` }, 15_000);
              }
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
