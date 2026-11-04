// Stage only the public executable, dashboard, documentation and licenses.
// No workspace dependencies, credentials, install scripts, or local state are published.
import { cp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stage = join(root, "dist/npm");
const manifest = JSON.parse(await readFile(join(root, "packages/cli/package.json"), "utf8"));
if (!existsSync(join(root, "packages/cli/dist/dashboard/index.html"))) {
  throw new Error("Build the CLI and dashboard first: pnpm build");
}
const { devDependencies, scripts, private: isPrivate, ...published } = manifest;
if (isPrivate) throw new Error("The CLI package is marked private");
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await cp(join(root, "packages/cli/dist"), join(stage, "dist"), { recursive: true });
for (const name of ["LICENSE", "NOTICE", "LICENSING.md"]) await cp(join(root, name), join(stage, name));
await writeFile(join(stage, "package.json"), JSON.stringify(published, null, 2) + "\n");

// npm has no repository-relative document or image resolver.
const github = "https://github.com/vincent38wargnier/ultimatehuman/blob/main/";
const raw = "https://raw.githubusercontent.com/vincent38wargnier/ultimatehuman/main/";
const isRelative = (url) => !/^(?:[a-z]+:|\/|#)/i.test(url);
let readme = await readFile(join(root, "README.md"), "utf8");
readme = readme.replace(/(!?\[[^\]]*\]\()([^\s)]+)(\))/g, (all, start, url, end) =>
  isRelative(url) ? `${start}${start.startsWith("!") ? raw : github}${url}${end}` : all);
readme = readme.replace(/\b(src|href)="([^"]+)"/g, (all, attr, url) =>
  isRelative(url) ? `${attr}="${attr === "src" ? raw : github}${url}"` : all);
await writeFile(join(stage, "README.md"), readme);

// Preserve full notices for bundled runtime dependencies, including browser fonts.
const seen = new Set();
const notices = [];
async function visit(packageFile) {
  packageFile = await realpath(packageFile);
  if (seen.has(packageFile)) return;
  seen.add(packageFile);
  const pkg = JSON.parse(await readFile(packageFile, "utf8"));
  const dir = dirname(packageFile);
  if (!pkg.name.startsWith("@ultimatehuman/")) {
    const names = (await readdir(dir)).filter((name) => /^(?:licen[sc]e|copying|notice|ofl)(?:[.-]|$)/i.test(name));
    if (!names.length) throw new Error(`Missing bundled dependency license: ${pkg.name}`);
    const texts = await Promise.all(names.sort().map(async (name) => `${name}\n${await readFile(join(dir, name), "utf8")}`));
    notices.push({ name: `${pkg.name}@${pkg.version}`, text: `${pkg.name}@${pkg.version} (${pkg.license ?? "see license"})\n${texts.join("\n\n")}` });
  }
  const require = createRequire(packageFile);
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    let next;
    try { next = require.resolve(`${name}/package.json`); }
    catch {
      let parent = dirname(require.resolve(name));
      while (parent !== dirname(parent)) {
        const candidate = join(parent, "package.json");
        if (existsSync(candidate) && JSON.parse(await readFile(candidate, "utf8")).name === name) { next = candidate; break; }
        parent = dirname(parent);
      }
    }
    if (!next) throw new Error(`Cannot resolve runtime dependency ${name}`);
    await visit(next);
  }
}
for (const name of ["core", "sdk", "dashboard"]) await visit(join(root, "packages", name, "package.json"));
for (const name of await readdir(join(root, "packages/plugins"))) {
  const file = join(root, "packages/plugins", name, "package.json");
  if (existsSync(file)) await visit(file);
}
await writeFile(join(stage, "THIRD_PARTY_NOTICES.txt"),
  "ultimatehuman includes the following open-source dependencies.\n\n" +
  notices.sort((a, b) => a.name.localeCompare(b.name)).map((n) => n.text).join("\n\n" + "=".repeat(80) + "\n\n") + "\n");
console.log(`Prepared ${manifest.name}@${manifest.version} in dist/npm (${notices.length} dependency notices).`);
