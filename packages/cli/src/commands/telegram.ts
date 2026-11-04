import { controlKey, loadConfig } from "@ultimatehuman/core";

/** Pair the existing bot token; the token never enters the conversation. */
export async function telegram(): Promise<number> {
  try {
    const config = await loadConfig();
    const response = await fetch(`http://127.0.0.1:${config.server.port}/api/chat/telegram/connect`, {
      method: "POST", headers: { "content-type": "application/json", "x-uh-control": controlKey() }, body: "{}",
    });
    const result = await response.json() as { error?: string; link?: string; paired?: boolean };
    if (!response.ok) throw new Error(result.error || "Could not connect Telegram.");
    console.log(result.paired ? "Telegram is connected." : "Open this private link and press Start in Telegram (expires in 10 minutes):");
    console.log(result.link);
    return 0;
  } catch (e) { console.error((e as Error).message); return 1; }
}
