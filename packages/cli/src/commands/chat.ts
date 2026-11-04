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
  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout, terminal: true }) : null;
  let closed = false;
  rl?.on("close", () => (closed = true));
  type State = { messages: any[]; busy: number; permissions?: { id: string; tool: string; input: Record<string, unknown> }[]; connections?: { status: string; source: string }[] };
  const readState = async (): Promise<State> => {
    const r = await fetch(base, { headers });
    if (!r.ok) throw new Error("The engine connection was lost.");
    return await r.json() as State;
  };
  const waitForReply = async (initial: State): Promise<State | null> => {
    let state = initial;
    while (state.busy) {
      for (const permission of state.permissions ?? []) {
        console.log(`\nThe assistant requests ${permission.tool}:\n${JSON.stringify(permission.input, null, 2)}`);
        if (!rl || closed) {
          console.log(`Open http://127.0.0.1:${port}/chat to approve or decline this operation.`);
          return null;
        }
        const answer = await rl.question("Allow this operation? [y/N] ").catch(() => "n");
        await fetch(`${base}/permissions/${permission.id}`, { method: "POST", headers, body: JSON.stringify({ allow: /^y(es)?$/i.test(answer.trim()) }) });
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      state = await readState();
    }
    if (state.connections?.some((r) => r.status === "pending")) console.log(`\nComplete the connection form in your workspace: http://127.0.0.1:${port}/chat`);
    return state;
  };
  const send = async (text: string): Promise<boolean> => {
    const r = await fetch(base, { method: "POST", headers, body: JSON.stringify({ text, source: "cli" }) }).catch((e: Error) => e);
    if (r instanceof Error || !r.ok) {
      console.error(`error: ${r instanceof Error ? r.message : ((await r.json().catch(() => ({}))) as any).error ?? r.status}`);
      return false;
    }
    const { user } = await r.json() as { user: { id: number } };
    const state = await waitForReply(await readState());
    if (!state) return false;
    const reply = state.messages.find((m) => m.id > user.id && m.role === "assistant");
    if (reply) show(reply);
    return true;
  };
  try {
  if (positionals.length) return (await send(positionals.join(" "))) ? 0 : 1;

  let state = (await hist.json()) as State;
  // A fresh installation already queued Claude's opening question. Show its
  // answer before prompting, so terminal setup does not silently miss it.
  if (state.busy) console.log("Working…");
  const ready = await waitForReply(state);
  if (!ready) return 1;
  state = ready;
  const { messages, busy } = state;
  if (messages.length) console.log(`--- last ${Math.min(10, messages.length)} of ${messages.length} messages ---`);
  for (const m of messages.slice(-10)) show(m);
  console.log(`\nSetup chat${busy ? ` (${busy} turn${busy === 1 ? "" : "s"} running)` : ""}. Type a message; Ctrl-D or /exit to quit.`);
  if (rl) {
    while (!closed) {
      const t = (await rl.question("\n> ").catch(() => "/exit")).trim();
      if (t === "/exit" || t === "/quit") break;
      if (t) { console.log("Working…"); await send(t); }
    }
  } else {
    const input = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    for await (const line of input) {
      const t = line.trim();
      if (t === "/exit" || t === "/quit") break;
      if (t && !await send(t)) { input.close(); return 1; }
    }
    input.close();
  }
  return 0;
  } finally { rl?.close(); }
}
