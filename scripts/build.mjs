// Bundles the CLI (core + plugins) into one ESM file that runs under plain `node`.
import { build } from "esbuild";
import { chmod, cp, rm } from "node:fs/promises";
await build({
  entryPoints: ["packages/cli/src/index.ts"],
  outfile: "packages/cli/dist/cli.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["bufferutil", "utf-8-validate"],
  loader: { ".md": "text", ".sh": "text", ".yml": "text" }, // CI check templates (packages/cli/templates/ci)
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
});
await chmod("packages/cli/dist/cli.mjs", 0o755);
await rm("packages/cli/dist/dashboard", { recursive: true, force: true });
await cp("packages/dashboard/dist", "packages/cli/dist/dashboard", { recursive: true });
