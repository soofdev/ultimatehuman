/** Fetch against the engine. Session is an HttpOnly cookie; the CSRF header comes from /api/status. No tokens in JS storage. */
let csrf = "";
export function setCsrf(v: string) {
  csrf = v;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: any,
  ) {
    super(message);
  }
}

export async function get<T = any>(path: string): Promise<T> {
  const r = await fetch(path, { credentials: "same-origin" });
  if (!r.ok) { const detail = await r.json().catch(() => ({})); throw new ApiError(r.status, detail.error ?? `HTTP ${r.status}`, detail); }
  return r.json();
}

export async function post<T = any>(path: string, body: unknown = {}): Promise<T> {
  const r = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-uh-csrf": csrf },
    body: JSON.stringify(body),
  });
  if (!r.ok) { const detail = await r.json().catch(() => ({})); throw new ApiError(r.status, detail.error ?? `HTTP ${r.status}`, detail); }
  return r.json();
}

/** Redeem the single-use code from the URL fragment, then wipe it from history. */
export async function redeemLoginFragment(): Promise<"ok" | "none" | string> {
  const code = new URLSearchParams(location.hash.slice(1)).get("code");
  if (!code) return "none";
  history.replaceState(null, "", "/login");
  try {
    await post("/api/auth/redeem", { code });
    history.replaceState(null, "", "/chat");
    return "ok";
  } catch (e) {
    return (e as Error).message;
  }
}

export function connectEvents(onEvent: (ev: any) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  const open = () => {
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/events`);
    ws.onmessage = (m) => onEvent(JSON.parse(m.data));
    ws.onclose = () => {
      if (!closed) setTimeout(open, 1500);
    };
  };
  open();
  return () => {
    closed = true;
    ws?.close();
  };
}
