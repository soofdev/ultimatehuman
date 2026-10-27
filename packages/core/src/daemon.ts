import type { Server } from "node:http";
import type { Config } from "./config/schema";
import { LoginLinks } from "./server/login-links";
import { startServer } from "./server/http";

export interface DaemonHandle {
  links: LoginLinks;
  server: Server;
  stop(): Promise<void>;
}

/**
 * Daemon entry: start the local server, then (core-engine leg) the scheduler.
 * Parked runs are resumed by a timer armed at the recorded reset time and
 * re-armed from the store on every boot, so a reboot never loses a parked run.
 */
export async function startDaemon(config: Config, version: string): Promise<DaemonHandle> {
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(config.server.host);
  if (!loopback && !config.server.allowRemote) {
    throw new Error(`refusing to bind ${config.server.host}: set server.allowRemote or use an SSH tunnel`);
  }
  const links = new LoginLinks();
  const server = await startServer({ host: config.server.host, port: config.server.port, version, links });
  return {
    links,
    server,
    stop: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
