// Smoke-test the actual npm tarball from a clean directory, without Claude or network services.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stage = join(root, "dist/npm");
const manifest = JSON.parse(await readFile(join(stage, "package.json"), "utf8"));
const source = JSON.parse(await readFile(join(root, "packages/cli/package.json"), "utf8"));
assert.equal(manifest.version, source.version, "Rebuild after changing the release version");
assert.equal(manifest.name, "ultimatehuman");
assert.equal(manifest.scripts, undefined, "No install-time scripts");
assert.equal(manifest.dependencies, undefined, "The bundle has no external runtime packages");
assert.equal(manifest.devDependencies, undefined, "No workspace dependency references");
assert.equal(manifest.license, source.license, "Rebuild after changing the release license");
assert.equal(manifest.license, JSON.parse(await readFile(join(root, "package.json"), "utf8")).license);
for (const name of ["LICENSE", "NOTICE", "LICENSING.md"]) {
  assert.equal(await readFile(join(stage, name), "utf8"), await readFile(join(root, name), "utf8"), `The package must include the current ${name}`);
}

const packed = JSON.parse((await exec("npm", ["pack", "--json", "--pack-destination", join(root, "dist")], { cwd: stage })).stdout)[0];
const tarball = join(root, "dist", packed.filename);
const files = new Set(packed.files.map((f) => f.path));
for (const file of ["package.json", "README.md", "LICENSE", "NOTICE", "LICENSING.md", "THIRD_PARTY_NOTICES.txt", "dist/cli.mjs", "dist/dashboard/index.html"]) {
  assert(files.has(file), `Missing package file: ${file}`);
}
for (const file of files) {
  assert(/^(?:package\.json|README\.md|LICENSE|NOTICE|LICENSING\.md|THIRD_PARTY_NOTICES\.txt|dist\/)/.test(file), `Unexpected file: ${file}`);
  assert(!/(?:^|\/)(?:\.env[^/]*|engine\.env|control\.key|state\.db|\.DS_Store|node_modules|\.git)(?:\/|$)/.test(file), `Local state in package: ${file}`);
}
const readme = await readFile(join(stage, "README.md"), "utf8");
assert(!/\]\((?:docs\/|LICENS(?:E|ING)|CONTRIBUTING|ROADMAP)/.test(readme), "npm README needs absolute document links");
assert(!/src="docs\//.test(readme), "npm README needs absolute image links");
console.log(`✓ Package contains CLI, dashboard, README, and licenses (${packed.files.length} files)`);

const scratch = await mkdtemp(join(tmpdir(), "uh-package-check-"));
const home = join(scratch, "workspace");
// Only selected environment variables: no real model credentials or user configuration.
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
  ULTIMATEHUMAN_HOME: home, ULTIMATEHUMAN_CONFIG: join(home, "config.json5"),
  ULTIMATEHUMAN_CLAUDE_BIN: join(scratch, "no-claude-installed"),
};
let engine;
let output = "";
try {
  await writeFile(join(scratch, "package.json"), '{"private":true}\n');
  await exec("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--offline", tarball], { cwd: scratch, env });
  const cli = join(scratch, "node_modules/ultimatehuman/dist/cli.mjs");
  const version = await exec("npm", ["exec", "--offline", "--", "ultimatehuman", "--version"], { cwd: scratch, env });
  assert.equal(version.stdout.trim(), manifest.version);
  const help = await exec(process.execPath, [cli, "--help"], { cwd: scratch, env });
  assert(help.stdout.includes("shared setup chat"));
  assert(!existsSync(home), "--help and --version must not initialize a workspace");
  console.log("✓ Clean offline install exposes the executable and correct version");

  const port = await new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
  await mkdir(home);
  await writeFile(join(home, "config.json5"), JSON.stringify({
    auth: { sources: [{ id: "local", kind: "claude_login" }] },
    server: { port }, repos: [], pipelines: [], plugins: {},
  }));
  engine = spawn(process.execPath, [cli, "start"], { cwd: scratch, env, stdio: ["ignore", "pipe", "pipe"] });
  engine.stdout.on("data", (data) => { output += data; });
  engine.stderr.on("data", (data) => { output += data; });
  const base = `http://127.0.0.1:${port}`;
  let health;
  for (let i = 0; i < 100; i++) {
    if (engine.exitCode !== null) throw new Error(`Installed engine exited: ${output}`);
    health = await fetch(base + "/api/health").then((r) => r.json()).catch(() => null);
    if (health?.ok) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(health?.version, manifest.version, output);
  assert.equal((await fetch(base + "/api/status")).status, 401);
  const html = await (await fetch(base + "/chat")).text();
  assert(html.includes('<div id="root">'));
  // Vite loads route CSS through JavaScript, so check packed assets as well as HTML imports.
  const assets = [...new Set([
    ...[...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map((m) => m[1]),
    ...[...files].filter((p) => p.startsWith("dist/dashboard/assets/")).map((p) => p.slice("dist/dashboard".length)),
  ])];
  assert(assets.some((p) => p.endsWith(".js")));
  assert(assets.some((p) => p.endsWith(".css")));
  for (const asset of assets) {
    const res = await fetch(base + asset);
    assert.equal(res.status, 200, asset);
    assert(!res.headers.get("content-type")?.includes("text/html"), `Asset fell back to HTML: ${asset}`);
  }
  console.log("✓ Installed engine serves its bundled dashboard and version; API requires authentication");
} finally {
  if (engine && engine.exitCode === null) {
    const closed = new Promise((resolve) => engine.once("exit", resolve));
    engine.kill("SIGTERM");
    const timeout = setTimeout(() => engine.kill("SIGKILL"), 5000);
    await closed;
    clearTimeout(timeout);
  }
  await rm(scratch, { recursive: true, force: true });
}
console.log(`Ready: ${tarball}\nSHA-512 integrity: ${packed.integrity}`);
