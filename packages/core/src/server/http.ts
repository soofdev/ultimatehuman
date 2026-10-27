import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { LoginLinks } from "./login-links";

export interface Route {
  (req: IncomingMessage, body: any, params: Record<string, string>): Promise<{ status?: number; json: unknown }>;
}

export interface ServerOptions {
  host: string;
  port: number;
  staticDir: string | null;
  logDir: string;
  controlKey: string;
  routes: Record<string, Route>; // "GET /api/runs/:id"
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

export interface RunningServer {
  server: Server;
  links: LoginLinks;
  broadcast(ev: unknown): void;
  loginUrl(): string;
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie ?? "");
  return m?.[1];
}

export function startServer(o: ServerOptions): Promise<RunningServer> {
  const links = new LoginLinks();
  const csrfFor = (sid: string) => createHmac("sha256", o.controlKey).update("csrf:" + sid).digest("hex").slice(0, 32);
  const isControl = (req: IncomingMessage) => {
    const h = String(req.headers["x-uh-control"] ?? "");
    return h.length === o.controlKey.length && timingSafeEqual(Buffer.from(h), Buffer.from(o.controlKey));
  };
  const access = (line: string) => void appendFile(join(o.logDir, "access.log"), `${new Date().toISOString()} ${line}\n`).catch(() => {});
  const compiled = Object.entries(o.routes).map(([k, fn]) => {
    const [method, path] = k.split(" ") as [string, string];
    const names: string[] = [];
    const re = new RegExp("^" + path.replace(/:(\w+)/g, (_, n) => (names.push(n), "([^/]+)")) + "$");
    return { method, re, names, fn };
  });
  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    access(`${req.method} ${path}`); // path only: the login code lives in the fragment and never reaches us
    try {
      if (path.startsWith("/api/")) {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = raw ? JSON.parse(raw) : {};
        if (req.method === "GET" && path === "/api/health") return send(res, 200, { ok: true, version: "0.1.0-slice" });
        if (req.method === "POST" && path === "/api/auth/redeem") {
          const sid = links.redeem(String(body.code ?? ""));
          if (!sid) return send(res, 401, { error: "This login link was already used or has expired. Run `ultimatehuman dashboard` for a new one." });
          return send(res, 200, { ok: true }, { "set-cookie": `uh_sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 24 * 3600}` });
        }
        if (req.method === "POST" && path === "/api/auth/link") {
          if (!isControl(req)) return send(res, 403, { error: "control key required" });
          return send(res, 200, { url: `http://${o.host}:${o.port}/login#code=${links.issue()}` });
        }
        const control = isControl(req);
        const sid = cookie(req, "uh_sid");
        if (!control && !links.check(sid)) return send(res, 401, { error: "not signed in" });
        if (!control && req.method !== "GET" && req.headers["x-uh-csrf"] !== csrfFor(sid!)) return send(res, 403, { error: "missing CSRF header" });
        if (req.method === "POST" && path === "/api/auth/logout") return send(res, 200, { ok: true }, { "set-cookie": "uh_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
        for (const r of compiled) {
          if (r.method !== req.method) continue;
          const m = r.re.exec(path);
          if (!m) continue;
          const params: Record<string, string> = {};
          r.names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1]!)));
          const out = await r.fn(req, body, params);
          if (path === "/api/status" && sid) (out.json as any).csrf = csrfFor(sid);
          return send(res, out.status ?? 200, out.json);
        }
        return send(res, 404, { error: "not found" });
      }
      if (!o.staticDir) return send(res, 404, { error: "dashboard not built" });
      const file = normalize(join(o.staticDir, path)).startsWith(o.staticDir) ? join(o.staticDir, path) : "";
      const target = file && existsSync(file) && extname(file) ? file : join(o.staticDir, "index.html");
      const data = await readFile(target);
      res.writeHead(200, {
        "content-type": MIME[extname(target)] ?? "application/octet-stream",
        "cache-control": target.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
      });
      res.end(data);
    } catch (e) {
      send(res, 500, { error: (e as Error).message });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://x").pathname !== "/api/events" || !links.check(cookie(req, "uh_sid"))) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.on("close", () => clients.delete(ws));
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host, () =>
      resolve({
        server,
        links,
        broadcast: (ev) => {
          const s = JSON.stringify(ev);
          for (const c of clients) if (c.readyState === 1) c.send(s);
        },
        loginUrl: () => `http://${o.host}:${o.port}/login#code=${links.issue()}`,
      }),
    );
  });
}
