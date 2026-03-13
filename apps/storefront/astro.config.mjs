// astro.config.mjs

// @ts-check
import { defineConfig, envField } from "astro/config";
import react from "@astrojs/react";
import partytown from "@astrojs/partytown";
import tailwindcss from "@tailwindcss/vite";
import { partytownConfig } from "./src/lib/partytown-config.ts";
import { CDN_DOMAINS } from "./src/lib/image-config.ts";
import cloudflare from "@astrojs/cloudflare";

// https://astro.build/config
export default defineConfig({
  devToolbar: { enabled: false },

  // This `image` block is used for build-time rendering and local development.
  // The `squoosh` service works locally without needing a Cloudflare environment.
  image: {
    domains: CDN_DOMAINS,
    service: {
      entrypoint: "astro/assets/services/squoosh",
    },
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
      alias:
        process.env.NODE_ENV === "production"
          ? {
            "react-dom/server": "react-dom/server.edge",
          }
          : undefined,
    },
    ssr: {
      noExternal: [/^@radix-ui\/.*/, "lucide-react"],
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

  // This adapter configures the production deployment for Cloudflare.
  adapter: cloudflare({
    // THIS IS THE KEY CHANGE:
    // This tells the adapter to use Cloudflare's real-time image resizing service
    // for all server-rendered pages, overriding the `squoosh` service defined above.
    imageService: "cloudflare",

    platformProxy: { enabled: true },
  }),
});
