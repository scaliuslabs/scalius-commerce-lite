import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
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
    // tailwind → cloudflare → tanstackStart → react
    tailwindcss(),
    cloudflare({
      viteEnvironment: { name: "ssr" },
      persistState: { path: "../../.wrangler/state" },
    }),
    tanstackStart(),
    viteReact(),
  ],
});
