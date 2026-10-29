import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { Finding } from "@ultimatehuman/sdk";

/**
 * Photographs the dashboard's own finding card (/render/finding-card) with the
 * Chrome or Chromium already on this machine, driven over the DevTools
 * protocol. No browser is bundled: when none is found, notifiers fall back to
 * text and say so in the log.
 */
export function chromeBin(): string | null {
  const env = process.env.ULTIMATEHUMAN_CHROME;
  if (env) return existsSync(env) ? env : null;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]) {
    try {
      const p = execFileSync("which", [name], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      if (p) return p;
    } catch {
      /* not on PATH */
    }
  }
  const fixed = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"];
  for (const p of fixed) if (existsSync(p)) return p;
  // A Playwright install leaves a full Chromium behind.
  for (const cache of [join(homedir(), ".cache", "ms-playwright"), join(homedir(), "Library", "Caches", "ms-playwright")]) {
    if (!existsSync(cache)) continue;
    for (const d of readdirSync(cache).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
      for (const rel of ["chrome-linux/chrome", "chrome-linux64/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
        if (existsSync(join(cache, d, rel))) return join(cache, d, rel);
      }
    }
  }
  return null;
}

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function renderFindingCard(f: Finding, dashboardBase: string, opts: { width?: number; timeoutMs?: number } = {}): Promise<Uint8Array> {
  const bin = chromeBin();
  if (!bin) throw new Error("no Chrome or Chromium found (set ULTIMATEHUMAN_CHROME to its path)");
  const width = opts.width ?? 720;
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  const profile = mkdtempSync(join(tmpdir(), "uh-card-"));
  const chrome = spawn(
    bin,
    ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--mute-audio", "--remote-debugging-port=0", `--user-data-dir=${profile}`, `--window-size=${width},1000`, "about:blank"],
    { stdio: "ignore" },
  );
  const left = () => Math.max(0, deadline - Date.now());
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    let port = 0;
    while (!port) {
      if (!left()) throw new Error("headless browser did not start");
      const f2 = join(profile, "DevToolsActivePort");
      if (existsSync(f2)) port = Number(readFileSync(f2, "utf8").split("\n")[0]);
      else await wait(100);
    }
    const pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const ws = new WebSocket(pages.find((p) => p.type === "page")!.webSocketDebuggerUrl);
    await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
    let seq = 0;
    const pending = new Map<number, (v: any) => void>();
    ws.on("message", (m) => {
      const msg = JSON.parse(String(m));
      if (msg.id && pending.has(msg.id)) pending.get(msg.id)!(msg);
    });
    const cdp = (method: string, params: Record<string, unknown> = {}): Promise<any> =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        const t = setTimeout(() => reject(new Error(`headless browser: ${method} timed out`)), left());
        pending.set(id, (msg) => {
          clearTimeout(t);
          pending.delete(id);
          msg.error ? reject(new Error(`headless browser: ${method}: ${msg.error.message}`)) : resolve(msg.result);
        });
        ws.send(JSON.stringify({ id, method, params }));
      });
    try {
      await cdp("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 2, mobile: false });
      await cdp("Page.navigate", { url: `${dashboardBase.replace(/\/$/, "")}/render/finding-card#f=${b64url(JSON.stringify(f))}` });
      let rect: { x: number; y: number; width: number; height: number } | null = null;
      while (!rect) {
        if (!left()) throw new Error("the card page did not render (is the dashboard built?)");
        const r = await cdp("Runtime.evaluate", {
          expression: `(() => { const el = document.body.hasAttribute('data-render-ready') && document.querySelector('.fcard'); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`,
          returnByValue: true,
        });
        rect = r.result.value ?? null;
        if (!rect) await wait(150);
      }
      const pad = 14;
      const shot = await cdp("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: { x: Math.max(0, rect.x - pad), y: Math.max(0, rect.y - pad), width: rect.width + pad * 2, height: rect.height + pad * 2, scale: 1 },
      });
      return Buffer.from(shot.data, "base64");
    } finally {
      ws.close();
    }
  } finally {
    chrome.kill("SIGKILL");
    await wait(100);
    rmSync(profile, { recursive: true, force: true });
  }
}
