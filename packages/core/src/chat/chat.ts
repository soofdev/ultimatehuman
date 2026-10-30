import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config/schema";
import { DEFAULT_MODEL } from "../config/schema";
import { runClaude } from "../runner/claude";
import type { ChatMessage, ChatSource, Store } from "../store/store";

/**
 * The setup chat: ONE conversation, three doors (dashboard, CLI, Telegram).
 * Each turn is one `claude -p` that resumes the session id kept in the kv store,
 * the same one-shot-per-message pattern as a Telegram -> Claude Code bridge.
 * Turns are serialized: one in flight whatever the door; the rest wait in order.
 * The agent's only tool is the config: it answers with a fenced `config-patch`
 * block, which the daemon applies through the same validated write path the
 * Config page uses, then reports in the reply.
 */

const SESSION_KEY = "chat.session";

export const CHAT_SYSTEM = `You are the setup assistant of this ultimatehuman install (a local radar that reads error trackers and analytics, and turns real user pain into findings a human rules on).
You talk to the person who installed it, through the dashboard Chat page, the \`ultimatehuman chat\` CLI or Telegram — it is one conversation; each user message is tagged with the door it came through.
Your job: explain the config and change it for them. You have NO file or shell tools. Each message carries the current config file (JSON5) — that is the source of truth.
To change the config, end your reply with ONE fenced block tagged config-patch holding a JSON object that is deep-merged into the file (objects merge, arrays and values replace, null deletes a key). Example:
\`\`\`config-patch
{ "features": { "validationGate": true } }
\`\`\`
The daemon validates and applies it, then tells the user what changed (or why it was refused). Never put a secret value in a patch: secrets must be "\${ENV_VAR}" references. Only patch what the user asked for. Be brief: short sentences, no tables.`;

export type ApplyPatch = (patch: Record<string, unknown>) => Promise<void>;

export interface ChatDeps {
  home: string;
  store: Store;
  getConfig: () => Config;
  readRawConfig: () => Promise<string>;
  applyPatch: ApplyPatch;
  runnerEnv: () => Promise<Record<string, string>>;
  emit: (ev: unknown) => void;
  log: (m: string) => void;
}

/** Deep merge for config patches: objects merge, everything else replaces, null deletes. */
export function mergePatch(target: Record<string, any>, patch: Record<string, any>): Record<string, any> {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete target[k];
    else if (typeof v === "object" && !Array.isArray(v) && typeof target[k] === "object" && target[k] && !Array.isArray(target[k])) mergePatch(target[k], v);
    else target[k] = v;
  }
  return target;
}

/** Dotted paths a patch touches, for the confirmation line. */
function paths(o: Record<string, any>, pre = ""): string[] {
  return Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" && !Array.isArray(v) ? paths(v, `${pre}${k}.`) : [`${pre}${k} = ${JSON.stringify(v)}`]));
}

export class Chat {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  constructor(private d: ChatDeps) {
    mkdirSync(join(d.home, "chat"), { recursive: true });
  }

  /** Turns waiting or running (0 = idle). */
  busy(): number {
    return this.pending;
  }

  history(limit = 200): ChatMessage[] {
    return this.d.store.listChat(limit);
  }

  /** Records the user's message at once, queues the agent turn, resolves with the reply. */
  send(text: string, source: ChatSource): { user: ChatMessage; reply: Promise<ChatMessage> } {
    const user = this.d.store.addChat({ role: "user", text, source });
    this.d.emit({ type: "chat.message", message: user });
    this.pending++;
    this.d.emit({ type: "chat.busy", busy: this.pending });
    const reply = this.tail.then(() => this.turn(text, source)).finally(() => {
      this.pending--;
      this.d.emit({ type: "chat.busy", busy: this.pending });
    });
    this.tail = reply.catch(() => {});
    return { user, reply };
  }

  private async turn(text: string, source: ChatSource): Promise<ChatMessage> {
    const cfg = this.d.getConfig();
    const resume = this.d.store.getKv<string>(SESSION_KEY);
    const prompt = `[door: ${source}]\n\nCurrent config file:\n\`\`\`json5\n${await this.d.readRawConfig()}\`\`\`\n\nUser: ${text}`;
    const r = await runClaude({
      prompt,
      cwd: join(this.d.home, "chat"),
      model: cfg.models?.chat ?? DEFAULT_MODEL,
      maxTurns: 2,
      tools: [],
      env: await this.d.runnerEnv(),
      appendSystemPrompt: CHAT_SYSTEM,
      timeoutMs: 5 * 60_000,
      ...(resume ? { resumeSessionId: resume } : {}),
    });
    if (r.sessionId) this.d.store.setKv(SESSION_KEY, r.sessionId);
    let out = r.ok ? r.text.trim() : `The agent turn failed: ${r.error ?? "unknown error"}`;
    if (r.ok) out = await this.applyPatches(out);
    this.d.log(`chat turn (${source}): ${r.ok ? "ok" : `failed: ${r.error}`} in ${r.durationMs}ms`);
    const msg = this.d.store.addChat({ role: "assistant", text: out, source });
    this.d.emit({ type: "chat.message", message: msg });
    return msg;
  }

  /** Applies each `config-patch` block and swaps it for a line saying what happened. */
  private async applyPatches(text: string): Promise<string> {
    const re = /```config-patch\s*([\s\S]*?)```/g;
    let out = "";
    let last = 0;
    for (const m of text.matchAll(re)) {
      out += text.slice(last, m.index);
      last = m.index! + m[0].length;
      try {
        const patch = JSON.parse(m[1]!) as Record<string, unknown>;
        if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("the patch must be a JSON object");
        await this.d.applyPatch(patch);
        this.d.log(`chat config patch applied: ${paths(patch).join(", ")}`);
        out += `\n\n✅ Config updated: ${paths(patch).map((p) => `\`${p}\``).join(", ")}`;
      } catch (e) {
        out += `\n\n⚠️ Config change refused: ${(e as Error).message.slice(0, 400)}`;
      }
    }
    return (out + text.slice(last)).trim();
  }
}
