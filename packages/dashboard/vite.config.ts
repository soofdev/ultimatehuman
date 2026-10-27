import { defineConfig, transformWithEsbuild, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const shim = (p: string) => here(`./src/verbatim/shims/${p}`);

/** The vendored reference files (app/) are Next.js .js files with JSX. */
function jsxInJs(): Plugin {
  return {
    name: "vendored-jsx-in-js",
    enforce: "pre",
    async transform(code, id) {
      if (!id.includes("/dashboard/app/") || !id.endsWith(".js")) return null;
      const out = await transformWithEsbuild(code, id, { loader: "jsx", jsx: "automatic" });
      return { code: out.code, map: out.map as any };
    },
  };
}

export default defineConfig({
  plugins: [jsxInJs(), react()],
  resolve: {
    // Next.js plumbing of the vendored files, resolved to thin adapters (src/verbatim/shims), then "@/" = this package root.
    alias: [
      { find: /^next\/navigation$/, replacement: shim("next-navigation.js") },
      { find: /^next\/link$/, replacement: shim("next-link.jsx") },
      { find: /^next-auth\/react$/, replacement: shim("next-auth-react.js") },
      { find: /^next-auth$/, replacement: shim("next-auth.js") },
      { find: /^@\/app\/api\/auth\/\[\.\.\.nextauth\]\/route$/, replacement: shim("auth-route.js") },
      { find: /^@\/lib\/db\/db$/, replacement: shim("db.js") },
      { find: /^@\/app\/models\/(platform-claim|pipeline-ticket|pipeline-bundles)$/, replacement: shim("model-$1.js") },
      { find: /^@\//, replacement: here("./") },
    ],
  },
  server: { proxy: { "/api": { target: "http://127.0.0.1:4747", ws: true } } },
});
