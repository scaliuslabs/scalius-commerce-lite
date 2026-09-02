import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const persistStatePath = process.env.SCALIUS_WRANGLER_STATE || "../../.wrangler/state";
const generatedAssetDir = "assets/immutable";

export default defineConfig(({ mode }) => ({
  environments: {
    client: {
      build: {
        // Only content-hashed browser bundles enter the immutable cache namespace.
        // Files copied from public/ keep their stable, non-immutable URLs.
        assetsDir: generatedAssetDir,
        sourcemap: false,
        rolldownOptions: {
          output: {
            // TanStack's route boundaries stay lazy, while Rolldown folds the
            // icon library into useful payloads instead of making every cold
            // route pay dozens of tiny icon requests. Do not force all
            // `$initial` modules into size-split groups: Rolldown can split a
            // strongly connected ESM graph across those chunks, causing an
            // import to execute before its function export is initialized.
            codeSplitting: {
              groups: [
                {
                  // One unsplit initial group keeps the framework's strongly
                  // connected runtime together. The build's import-cycle gate
                  // protects this boundary if Rolldown behavior changes.
                  name: "admin-shell",
                  tags: ["$initial"],
                  priority: 100,
                },
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
    },
    ssr: {
      build: {
        // SSR renders URLs from its own manifest. Keep those URLs aligned with
        // the client output so a deploy cannot reference non-existent assets.
        assetsDir: generatedAssetDir,
        sourcemap: false,
      },
    },
  },
  server: {
    port: 4323,
    proxy: {
      "/api/v1": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
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
    // Official TanStack Start + Cloudflare plugin order:
    // cloudflare → tanstackStart → react
    // Unit tests run in Vitest's Node environment rather than workerd. Vite
    // 8.2 injects Node built-ins into that environment's `resolve.external`,
    // which Cloudflare Vite 1.51 correctly rejects for a Worker build.
    mode !== "test" &&
      cloudflare({
        viteEnvironment: { name: "ssr" },
        persistState: { path: persistStatePath },
        config:
          mode === "development"
            ? { vars: { LOCAL_MAILPIT_URL: "http://127.0.0.1:8025" } }
            : undefined,
      }),
    tanstackStart(),
    viteReact(),
    tailwindcss(),
  ],
}));
