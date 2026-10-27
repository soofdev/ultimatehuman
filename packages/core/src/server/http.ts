import { createServer, type Server } from "node:http";
import type { LoginLinks } from "./login-links";

export interface ServerOptions {
  host: string;
  port: number;
  version: string;
  links: LoginLinks;
}

/** Stub HTTP server: health + auth redeem. Routes from ApiRoutes are filled in by the dashboard leg. */
export function startServer(opts: ServerOptions): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: opts.version }));
      return;
    }
    const sid = /(?:^|;\s*)uh_session=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    if (req.url?.startsWith("/api/") && req.url !== "/api/auth/redeem" && !opts.links.check(sid)) {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(501, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not implemented in skeleton" }));
  });
  return new Promise((resolve) => server.listen(opts.port, opts.host, () => resolve(server)));
}
