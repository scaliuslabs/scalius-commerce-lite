// astro.config.mjs

// @ts-check
import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import deferredPartytown from "./integrations/deferred-partytown.mjs";
import { partytownConfig } from "./src/lib/partytown-config.ts";
import { CDN_DOMAINS } from "./src/lib/image-config.ts";
import cloudflare from "@astrojs/cloudflare";
import { readBuildAssetsDirectory } from "./scripts/build-assets-directory.mjs";

const persistStatePath =
  process.env.SCALIUS_WRANGLER_STATE || "../../.wrangler/state";
const buildAssetsDirectory = readBuildAssetsDirectory(
  new URL("./src/config/build-id.ts", import.meta.url),
);
const reactSingletonDeps = [
  "react",
  "react-dom",
  "react-dom/client",
  "react-dom/server",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
];

// https://astro.build/config
export default defineConfig({
  devToolbar: { enabled: false },

  image: {
    domains: CDN_DOMAINS,
  },

  prefetch: {
    prefetchAll: true,
  },

  build: {
    // Astro's entry chunk name can remain stable when a referenced client module
    // changes. Scope the whole asset directory to BUILD_ID so a browser can safely
    // cache deployed JS/CSS as immutable without executing a previous build.
    assets: buildAssetsDirectory,
    // Keep only genuinely small route styles inline. The shared Tailwind output
    // is large enough that forcing it into every edge-cached HTML response delays
    // body discovery and prevents browsers from reusing it across navigations.
    inlineStylesheets: "auto",
  },

  output: "server",
  compressHTML: true,

  integrations: [
    react(),
    deferredPartytown({
      config: partytownConfig,
    }),
  ],

  vite: {
    plugins: [tailwindcss()],
    resolve: {
      dedupe: reactSingletonDeps,
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
      // With inlineStylesheets:auto, keep compact layout/route CSS in the HTML
      // while externalizing the much larger shared Tailwind stylesheet.
      assetsInlineLimit: 8_192,
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
    persistState: { path: persistStatePath },
    // Unique inspector port so admin (9230) + storefront (9231) + API (9229) don't clash during parallel builds
    inspectorPort: 9231,
  }),
});
