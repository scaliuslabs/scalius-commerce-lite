// astro.config.mjs

// @ts-check
import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import partytown from "@astrojs/partytown";
import tailwindcss from "@tailwindcss/vite";
import { partytownConfig } from "./src/lib/partytown-config.ts";
import { CDN_DOMAINS } from "./src/lib/image-config.ts";
import cloudflare from "@astrojs/cloudflare";

// https://astro.build/config
export default defineConfig({
  devToolbar: { enabled: false },

  image: {
    domains: CDN_DOMAINS,
    remotePatterns: [{ protocol: "https" }],
  },

  prefetch: {
    prefetchAll: true,
  },

  build: {
    inlineStylesheets: "always",
  },

  output: "server",
  compressHTML: true,

  integrations: [
    react(),
    partytown({
      config: partytownConfig,
    }),
  ],

  vite: {
    plugins: [tailwindcss()],
    resolve: {
      dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
      alias:
        process.env.NODE_ENV === "production"
          ? {
            "react-dom/server": "react-dom/server.edge",
          }
          : undefined,
    },
    ssr: {
      noExternal: [
        /^@radix-ui\/.*/,
        "lucide-react",
        "sonner",
        "@nanostores/react",
        "nanostores",
        "embla-carousel-react",
        "class-variance-authority",
        "clsx",
        "tailwind-merge",
      ],
      external: ["node:buffer", "node:crypto", "node:util", "node:stream"],
      resolve: {
        conditions: ["workerd", "node", "worker"],
      },
    },
    build: {
      cssCodeSplit: true,
      minify: true,
    },
    server: {
      hmr: {
        overlay: true,
      },
    },
  },

  adapter: cloudflare({
    imageService: "passthrough",
    persistState: { path: "../../.wrangler/state" },
    // Unique inspector port so admin (9230) + storefront (9231) + API (9229) don't clash during parallel builds
    inspectorPort: 9231,
  }),
});
