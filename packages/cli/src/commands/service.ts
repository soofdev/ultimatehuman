import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, userInfo } from "node:os";
import { ensureHome, homeId, loadConfig, uhHome } from "@ultimatehuman/core";

/**
 * `service install | uninstall | status`: run the engine under the OS supervisor so it survives
 * logouts, crashes and reboots. macOS = launchd agent (Background session, user/<uid> domain, so it
 * loads at boot without anyone logged in); Linux = systemd user unit (needs `loginctl enable-linger`).
 * Secrets never go into the unit file: they live in <home>/engine.env (0600), read by `node --env-file`.
 */

const darwin = process.platform === "darwin";
/** One unit per data dir, so two installs (two projects) on one machine never collide. */
const slug = () => basename(uhHome()).replace(/^\./, "").replace(/[^A-Za-z0-9.-]/g, "-");
const label = () => (darwin ? `dev.ultimatehuman.${slug()}` : `${slug()}.service`);
const unitPath = () => (darwin ? join(homedir(), "Library", "LaunchAgents", `${label()}.plist`) : join(homedir(), ".config", "systemd", "user", label()));
const envPath = () => join(uhHome(), "engine.env");
const logPath = () => join(uhHome(), "logs", "engine-service.log");
const domain = () => `user/${userInfo().uid}`;

function sh(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }).toString() };
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer };
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

/** Every ${VAR} the config references (secrets stay references in config.json5). */
function referencedVars(node: unknown, acc = new Set<string>()): Set<string> {
  if (typeof node === "string") for (const m of node.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) acc.add(m[1]!);
  else if (Array.isArray(node)) node.forEach((n) => referencedVars(n, acc));
  else if (node && typeof node === "object") Object.values(node).forEach((n) => referencedVars(n, acc));
  return acc;
}

function readEnvFile(p: string): Map<string, string> {
  const m = new Map<string, string>();
  if (!existsSync(p)) return m;
  for (const l of readFileSync(p, "utf8").split("\n")) {
    const hit = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l);
    if (hit) m.set(hit[1]!, hit[2]!.replace(/^(['"])(.*)\1$/, "$2"));
  }
  return m;
}

/** The node on PATH that is this node (e.g. /opt/homebrew/bin/node), so a package-manager upgrade
 *  that swaps the versioned Cellar dir does not leave the unit pointing at a deleted binary. */
function stableNode(): string {
  const real = realpathSync(process.execPath);
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const cand = join(dir, "node");
    try {
      if (dir && realpathSync(cand) === real) return cand;
    } catch {
      /* not here */
    }
  }
  return process.execPath;
}

async function health(port: number): Promise<{ home?: string; pid?: number } | null> {
  return fetch(`http://127.0.0.1:${port}/api/health`)
    .then((r) => (r.ok ? (r.json() as Promise<{ home?: string; pid?: number }>) : null))
    .catch(() => null);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function plist(args: string[]): string {
  const x = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${x(label())}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${x(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>ULTIMATEHUMAN_HOME</key><string>${x(uhHome())}</string></dict>
  <key>WorkingDirectory</key><string>${x(uhHome())}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>LimitLoadToSessionType</key><string>Background</string>
  <key>StandardOutPath</key><string>${x(logPath())}</string>
  <key>StandardErrorPath</key><string>${x(logPath())}</string>
</dict>
</plist>
`;
}

function systemdUnit(args: string[]): string {
  const q = (s: string) => (/[\s"\\]/.test(s) ? `"${s.replace(/(["\\])/g, "\\$1")}"` : s);
  return `[Unit]
Description=ultimatehuman engine (${uhHome()})
After=network-online.target

[Service]
Environment=ULTIMATEHUMAN_HOME=${q(uhHome())}
WorkingDirectory=${q(uhHome())}
ExecStart=${args.map(q).join(" ")}
Restart=always
RestartSec=30
StandardOutput=append:${logPath()}
StandardError=append:${logPath()}

[Install]
WantedBy=default.target
`;
}

async function install(): Promise<number> {
  if (!darwin && process.platform !== "linux") {
    console.error(`service install supports macOS (launchd) and Linux (systemd), not ${process.platform}`);
    return 1;
  }
  const home = ensureHome();
  const config = await loadConfig();
  const port = config.server.port;

  // engine.env: every referenced secret, taken from this shell or kept from an earlier install.
  const env = readEnvFile(envPath());
  const missing: string[] = [];
  for (const v of referencedVars(config)) {
    if (process.env[v]) env.set(v, process.env[v]!);
    else if (!env.has(v)) missing.push(v);
  }
  if (missing.length) {
    console.error(`config references ${missing.map((m) => "$" + m).join(", ")} but neither this shell nor ${envPath()} has it. Export it and rerun.`);
    return 2;
  }
  env.set("PATH", process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"); // the service must find `claude` like this shell does
  writeFileSync(envPath(), [...env].map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  chmodSync(envPath(), 0o600);

  // Reinstall: stop the current service first so its supervisor does not respawn what we stop next.
  if (existsSync(unitPath())) {
    if (darwin) sh("launchctl", ["bootout", `${domain()}/${label()}`]);
    else sh("systemctl", ["--user", "stop", label()]);
    for (let i = 0; i < 50 && (await health(port))?.home === homeId(); i++) await new Promise((r) => setTimeout(r, 100));
  }
  // An engine started by init (not supervised) holds the port: hand over to the service.
  const pidFile = join(home, "engine.pid");
  const h = await health(port);
  if (h?.home === homeId() && existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8"));
    if (pid && pidAlive(pid)) {
      process.kill(pid, "SIGTERM");
      for (let i = 0; i < 50 && pidAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
      console.log(`stopped the unsupervised engine (pid ${pid}); the service takes over`);
    }
  } else if (h) {
    console.error(`port ${port} is held by another ultimatehuman install; set server.port in ${home}/config.json5`);
    return 1;
  }

  const cli = fileURLToPath(import.meta.url);
  const args = [stableNode(), `--env-file=${envPath()}`, "--disable-warning=ExperimentalWarning", cli, "start"];
  mkdirSync(join(unitPath(), ".."), { recursive: true });
  if (darwin) {
    writeFileSync(unitPath(), plist(args), { mode: 0o644 });
    sh("launchctl", ["bootout", `${domain()}/${label()}`]);
    const b = sh("launchctl", ["bootstrap", domain(), unitPath()]);
    if (!b.ok) {
      console.error(`launchctl bootstrap failed: ${b.out.trim()}`);
      return 1;
    }
  } else {
    writeFileSync(unitPath(), systemdUnit(args), { mode: 0o644 });
    sh("systemctl", ["--user", "daemon-reload"]);
    const e = sh("systemctl", ["--user", "enable", "--now", label()]);
    if (!e.ok) {
      console.error(`systemctl enable failed: ${e.out.trim()}`);
      return 1;
    }
    sh("systemctl", ["--user", "restart", label()]);
  }

  for (let i = 0; i < 150; i++) {
    const up = await health(port);
    if (up?.home === homeId()) {
      console.log(`✓ service ${label()} installed and running on 127.0.0.1:${port}`);
      console.log(`  unit: ${unitPath()}`);
      console.log(`  secrets: ${envPath()} (0600) · log: ${logPath()}`);
      console.log(`  schedule: radar pass at "${config.radar.schedule}" (local time), survives reboots`);
      if (!darwin && !sh("loginctl", ["show-user", userInfo().username, "-p", "Linger"]).out.includes("yes")) console.log("  ! run `loginctl enable-linger` so it also starts at boot without a login");
      return 0;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.error(`service installed but the engine did not answer on ${port} within 15s; see ${logPath()}`);
  return 1;
}

function uninstall(): number {
  if (!existsSync(unitPath())) {
    console.log("no service installed for this home");
    return 0;
  }
  if (darwin) sh("launchctl", ["bootout", `${domain()}/${label()}`]);
  else {
    sh("systemctl", ["--user", "disable", "--now", label()]);
  }
  rmSync(unitPath());
  if (!darwin) sh("systemctl", ["--user", "daemon-reload"]);
  console.log(`✓ service ${label()} removed (engine stopped; ${envPath()} kept)`);
  return 0;
}

async function status(json: boolean): Promise<number> {
  const port = await loadConfig().then((c) => c.server.port).catch(() => 4747);
  const installed = existsSync(unitPath());
  let loaded = false;
  let pid: number | undefined;
  if (installed && darwin) {
    const p = sh("launchctl", ["print", `${domain()}/${label()}`]);
    loaded = p.ok;
    const m = /\bpid = (\d+)/.exec(p.out);
    if (m) pid = Number(m[1]);
  } else if (installed) {
    loaded = sh("systemctl", ["--user", "is-active", label()]).out.trim() === "active";
    const m = /MainPID=(\d+)/.exec(sh("systemctl", ["--user", "show", label(), "-p", "MainPID"]).out);
    if (m && m[1] !== "0") pid = Number(m[1]);
  }
  const h = await health(port);
  const answering = h?.home === homeId();
  const s = { label: label(), unit: unitPath(), installed, loaded, pid, port, answering, log: logPath() };
  if (json) console.log(JSON.stringify(s, null, 2));
  else {
    console.log(`service ${s.label}: ${installed ? (loaded ? "installed, loaded" : "installed, NOT loaded") : "not installed"}${pid ? ` · pid ${pid}` : ""}`);
    console.log(`engine on 127.0.0.1:${port}: ${answering ? "answering" : h ? "another install answers here" : "not answering"}`);
    if (installed) console.log(`unit ${s.unit} · log ${s.log}`);
  }
  return installed && loaded && answering ? 0 : 1;
}

export function serviceInstalled(): boolean {
  return existsSync(unitPath());
}

export async function service(sub: string | undefined, flags: { json: boolean }): Promise<number> {
  switch (sub) {
    case "install":
      return install();
    case "uninstall":
      return uninstall();
    case "status":
      return status(flags.json);
    default:
      console.error("usage: ultimatehuman service install | uninstall | status [--json]");
      return 2;
  }
}
