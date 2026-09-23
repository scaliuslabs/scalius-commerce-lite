import { defineConfig } from "vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * The dashboard is a static single-page app. `vite build` writes `dist/`,
 * which the API Worker serves as its `ASSETS` binding (apps/api/wrangler.jsonc)
 * on the dashboard hostname. Locally, `vite dev` serves it on :4323 and
 * proxies the API Worker's dashboard routes.
 */
const API_DEV_ORIGIN = "http://localhost:8787";

export default defineConfig({
  build: {
    // Only content-hashed bundles enter the immutable cache namespace
    // (public/_headers). Files copied from public/ keep their stable URLs.
    assetsDir: "assets/immutable",
    sourcemap: false,
    rolldownOptions: {
      output: {
        // Route boundaries stay lazy, while Rolldown folds the icon library
        // into useful payloads instead of making every cold route pay dozens
        // of tiny icon requests. One unsplit initial group keeps the router's
        // strongly connected runtime together.
        codeSplitting: {
          groups: [
            { name: "admin-shell", tags: ["$initial"], priority: 100 },
            {
              name: "admin-icons",
              test: /node_modules[\\/]lucide-react/,
              priority: 50,
              entriesAware: true,
              entriesAwareMergeThreshold: 24 * 1024,
              maxSize: 64 * 1024,
            },
          ],
        },
      },
    },
  },
  experimental: {
    // The dashboard may be served below a runtime base path. index.html keeps
    // root-relative URLs (the Worker prefixes them per request); URLs built
    // inside JS and CSS (lazy-chunk preloads) resolve relative to the file
    // that references them, so they follow whatever prefix loaded it.
    renderBuiltUrl(_filename, { hostType }) {
      return hostType === "html" ? undefined : { relative: true };
    },
  },
  server: {
    port: 4323,
    proxy: {
      "/api/v1": { target: API_DEV_ORIGIN, changeOrigin: true },
      "/api/auth": { target: API_DEV_ORIGIN, changeOrigin: true },
      "/api/scanner-token": { target: API_DEV_ORIGIN, changeOrigin: true },
    },
  },
  resolve: {
    tsconfigPaths: true,
    alias: {
      "~/": resolve(__dirname, "./src") + "/",
      "@/": resolve(__dirname, "./src") + "/",
    },
  },
  plugins: [
    // The router plugin must run before the React plugin.
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    viteReact(),
    tailwindcss(),
  ],
});
