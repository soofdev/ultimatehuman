import { createInterface } from "node:readline/promises";
import { controlKey, extractSends, loadConfig } from "@ultimatehuman/core";

/**
 * `ultimatehuman chat`: the setup chat in a terminal. Same conversation as the
 * dashboard Chat page and Telegram; each line waits for its turn in the engine's queue.
 * `ultimatehuman chat "<message>"` sends one message and exits.
 */
export async function chat(positionals: string[]): Promise<number> {
  const port = await loadConfig().then((c) => c.server.port).catch(() => 4747);
  const base = `http://127.0.0.1:${port}/api/chat`;
  const headers = { "x-uh-control": controlKey(), "content-type": "application/json" };
  // Files the agent sends ([[send:/path]]) cannot render in a terminal: print their paths.
  const show = (m: { role: string; text: string; source: string; ts: string }) => {
    const { text, paths } = m.role === "assistant" ? extractSends(m.text) : { text: m.text, paths: [] };
    console.log(`\n${m.role === "user" ? "you" : "assistant"} [${m.source}] ${new Date(m.ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}\n${text}${paths.map((p) => `\n[file] ${p}`).join("")}`);
  };

  const hist = await fetch(base, { headers }).catch(() => null);
  if (!hist?.ok) {
    console.error("The engine is not running. Start it with `ultimatehuman start` (or rerun init).");
    return 1;
  }
  const send = async (text: string): Promise<boolean> => {
    const r = await fetch(base, { method: "POST", headers, body: JSON.stringify({ text, source: "cli", wait: true }) }).catch((e: Error) => e);
    if (r instanceof Error || !r.ok) {
      console.error(`error: ${r instanceof Error ? r.message : ((await r.json().catch(() => ({}))) as any).error ?? r.status}`);
      return false;
    }
    show(((await r.json()) as any).reply);
    return true;
  };

  if (positionals.length) return (await send(positionals.join(" "))) ? 0 : 1;

  const { messages, busy } = (await hist.json()) as { messages: any[]; busy: number };
  if (messages.length) console.log(`--- last ${Math.min(10, messages.length)} of ${messages.length} messages ---`);
  for (const m of messages.slice(-10)) show(m);
  console.log(`\nSetup chat${busy ? ` (${busy} turn${busy === 1 ? "" : "s"} running)` : ""}. Type a message; Ctrl-D or /exit to quit.`);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  let closed = false;
  rl.on("close", () => (closed = true));
  rl.setPrompt("\n> ");
  rl.prompt();
  for await (const line of rl) {
    const t = line.trim();
    if (t === "/exit" || t === "/quit") break;
    if (t) {
      if (!process.stdin.isTTY) console.log(t);
      process.stdout.write("…thinking\n");
      await send(t);
    }
    if (!closed) rl.prompt();
  }
  if (!closed) rl.close();
  return 0;
}
