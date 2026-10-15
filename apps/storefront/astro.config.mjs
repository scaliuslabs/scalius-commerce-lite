// astro.config.mjs

// @ts-check
import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import deferredPartytown from "./integrations/deferred-partytown.mjs";
import buildEnvIsolation from "./integrations/build-env-isolation.mjs";
import { partytownConfig } from "./src/lib/partytown-config.ts";
import cloudflare from "@astrojs/cloudflare";
import { readBuildAssetsDirectory } from "./scripts/build-assets-directory.mjs";
import { devOrigins, readDevPorts } from "../../scripts/dev-ports.mjs";

const persistStatePath =
  process.env.SCALIUS_WRANGLER_STATE || "../../.wrangler/state";
const buildAssetsDirectory = readBuildAssetsDirectory(
  new URL("./src/config/build-id.ts", import.meta.url),
);
// Local ports (scripts/dev-ports.mjs): `astro dev` listens on the storefront
// port and calls the API on the API port. Dev tooling only, never a Worker var.
const devPorts = readDevPorts();
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

  server: { port: devPorts.storefront },

  // No `image.domains`: the Cloudflare adapter runs the passthrough image
  // service and nothing renders astro:assets <Image>/<Picture> or getImage(),
  // so the remote-image allowlist has no effect. Media hosts are resolved per
  // request from dashboard media settings and the platform media URL.

  prefetch: {
    prefetchAll: true,
  },

  build: {
    // Astro's entry chunk name can remain stable when a referenced client module
    // changes. Scope the whole asset directory to BUILD_ID so a browser can safely
    // cache deployed JS/CSS as immutable without executing a previous build.
    assets: buildAssetsDirectory,
    // Bundled CSS stays out of the HTML: route and component sheets are
    // cached, immutable files the browser reuses across pages, discovered in
    // the head beside the shared sheet (no extra round trip). Only sheets
    // under 1 KB (`assetsInlineLimit`) inline, where a request would cost
    // more than the bytes; the page's theme tokens and font faces
    // (Layout.astro, ThemeFonts.astro) are inline because they differ per
    // store. An 8 KB limit used to put 6-13 KB of identical route CSS into
    // every edge-cached HTML response.
    inlineStylesheets: "auto",
  },

  output: "server",
  compressHTML: true,
  // Nothing uses Astro.session. Without this the Cloudflare adapter enables a
  // KV session driver and adds a `SESSION` KV binding to the built Worker.
  session: false,

  integrations: [
    // Keeps .dev.vars, .env* and process.env values out of dist/: only the
    // built-in import.meta.env keys (DEV, SSR, ...) are inlined.
    buildEnvIsolation(),
    react(),
    deferredPartytown({
      config: partytownConfig,
    }),
  ],

  vite: {
    // Builds keep their own dependency cache: `astro build` (deploys, perf
    // checks) rewrites the optimizer cache and would break a dev server
    // running in the same checkout ("file does not exist … deps_ssr").
    cacheDir: process.argv.includes("build") ? "node_modules/.vite-build" : "node_modules/.vite",
    plugins: [tailwindcss()],
    define: {
      // Read only under `import.meta.env.DEV` (src/lib/api/transport.ts), so
      // a production build drops it with the dev branch.
      __SCALIUS_DEV_API_ORIGIN__: JSON.stringify(devOrigins(devPorts).apiUrl),
    },
    optimizeDeps: {
      entries: ["!**/*.d.{ts,mts,cts}"],
      // @astrojs/cloudflare misses these on cold Vite caches: withastro/astro#17788.
      include: ["astro/assets/services/noop", "astro/logger/json"],
    },
    environments: {
      astro: { optimizeDeps: { entries: ["!**/*.d.{ts,mts,cts}"] } },
      ssr: { optimizeDeps: { entries: ["!**/*.d.{ts,mts,cts}"] } },
      prerender: { optimizeDeps: { entries: ["!**/*.d.{ts,mts,cts}"] } },
    },
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
        "@nanostores/react",
        "nanostores",
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
      // The same 1 KB limit for module scripts and assets: page scripts are
      // deferred modules, so as immutable files they cost no render time and
      // are cached across pages instead of repeating 4-9 KB in every response.
      assetsInlineLimit: 1_024,
      minify: true,
      // Astro forces `build.minify: false` on the server build, so the
      // Worker shipped 4.6 MB of unminified modules. workerd compiles every
      // uploaded module when an isolate starts, so the bytes are cold-start
      // time: minified (2.7 MB) the storefront isolate starts in about 115 ms
      // instead of 185 ms (docs/STOREFRONT-PERFORMANCE.md, Cold start).
      // Rolldown's own `output.minify` is the one setting Astro passes on.
      rolldownOptions: { output: { minify: true } },
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
    // No fixed inspector port: parallel local stacks (API, worktrees) would
    // otherwise collide on it and the dev server exits before it is ready.
    inspectorPort: false,
  }),
});
