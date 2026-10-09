import { defineConfig } from "vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { DEFAULT_DEV_PORTS, devOrigins, previewProxyOrigin, readDevPorts } from "../../scripts/dev-ports.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * The dashboard is a static single-page app. `vite build` writes `dist/`,
 * which the API Worker serves as its `ASSETS` binding (apps/api/wrangler.jsonc)
 * on the dashboard hostname. Locally, `vite dev` serves it on the admin port
 * and proxies the API Worker's dashboard routes to the API port (both from
 * scripts/dev-ports.mjs: SCALIUS_DEV_ADMIN_PORT and SCALIUS_DEV_API_PORT,
 * default 4323 and 8787).
 */
const devPorts = readDevPorts();
const API_DEV_ORIGIN = devOrigins(devPorts).apiUrl;

/**
 * Dashboard UI preview (docs/ADMIN-QUALITY.md): this dev server may run on a
 * port other than the one in the API's Platform settings (a worktree on 4400
 * against the shared API on 8787). The API trusts only the Platform dashboard
 * origin, so the proxy presents that origin for requests that carry an Origin
 * (sign-in, writes, the realtime socket). Dev server only; loopback origins
 * only (`previewProxyOrigin`); the API is unchanged.
 */
let platformDashboardOrigin = devOrigins({ ...devPorts, admin: DEFAULT_DEV_PORTS.admin }).dashboardUrl;
let platformRead: Promise<void> | null = null;
function readPlatformDashboardOrigin(): Promise<void> {
  platformRead ??= fetch(`${API_DEV_ORIGIN}/api/v1/platform`)
    .then((response) => response.json() as Promise<{ data?: { dashboardUrl?: string } }>)
    .then((body) => {
      const origin = body.data?.dashboardUrl ? new URL(body.data.dashboardUrl).origin : "";
      if (origin) platformDashboardOrigin = origin;
    })
    .catch(() => {
      platformRead = null; // The API is not up yet: ask again on the next request.
    });
  return platformRead;
}

type ProxyRequest = { getHeader(name: string): unknown; setHeader(name: string, value: string): void };
function apiProxy(target: string) {
  const present = (request: ProxyRequest) => {
    const origin = request.getHeader("origin");
    if (typeof origin !== "string") return;
    const presented = previewProxyOrigin(origin, platformDashboardOrigin);
    if (presented && presented !== origin) {
      request.setHeader("origin", presented);
      if (typeof request.getHeader("referer") === "string") request.setHeader("referer", `${presented}/`);
    }
  };
  return {
    target,
    changeOrigin: true,
    configure(proxy: { on(event: string, handler: (request: ProxyRequest) => void): void }) {
      void readPlatformDashboardOrigin();
      proxy.on("proxyReq", present);
      proxy.on("proxyReqWs", present);
    },
  };
}

export default defineConfig(({ command }) => ({
  // Builds keep their own dependency cache so a deploy or perf build never
  // breaks a dev server running in the same checkout.
  cacheDir: command === "build" ? "node_modules/.vite-build" : "node_modules/.vite",
  // The dashboard reads no env: never load .env* files, so no local value can
  // be inlined into the browser bundle (scripts/check-build-canaries.mjs).
  envDir: false,
  build: {
    // Only content-hashed bundles enter the immutable cache namespace
    // (public/_headers). Files copied from public/ keep their stable URLs.
    assetsDir: "assets/immutable",
    sourcemap: false,
    rolldownOptions: {
      // The workspace packages' modules declare values and functions only: a
      // module none of a chunk's code uses stays out of it, as a package's
      // `"sideEffects": false` would say (Bangla transliteration tables, the
      // plugin schemas…). The dashboard's own modules keep the default.
      treeshake: {
        moduleSideEffects: (id) => (/[\\/]packages[\\/](shared|core)[\\/]src[\\/]/.test(id) ? false : undefined),
      },
      output: {
        // Route boundaries stay lazy, while Rolldown folds the icon library
        // into a few payloads by the screens that use them: no route pays
        // dozens of tiny icon requests, nor every other screen's icons (a
        // 24 KiB merge threshold made two bundles of all of them). One
        // unsplit initial group keeps the router's strongly connected
        // runtime together.
        codeSplitting: {
          groups: [
            { name: "admin-shell", tags: ["$initial"], priority: 100 },
            {
              name: "admin-icons",
              test: /node_modules[\\/]lucide-react/,
              priority: 50,
              entriesAware: true,
              entriesAwareMergeThreshold: 8 * 1024,
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
    port: devPorts.admin,
    strictPort: true,
    proxy: {
      "/api/v1": apiProxy(API_DEV_ORIGIN),
      "/api/auth": apiProxy(API_DEV_ORIGIN),
      "/api/scanner-token": apiProxy(API_DEV_ORIGIN),
      "/api/realtime": { ...apiProxy(API_DEV_ORIGIN), ws: true },
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
    // The router plugin must run before the React plugin. A route's loader is
    // split like its page: the first download keeps only what matches URLs
    // (paths, search validation, guards), so no screen pays for every other
    // screen's reads and SDK calls. The router fetches a route's loader and
    // page code together when it is opened or preloaded.
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      codeSplittingOptions: { defaultBehavior: [["loader"], ["component"], ["errorComponent"], ["notFoundComponent"]] },
    }),
    // React Compiler stays off: `viteReact({ compiler: true })` (native oxc
    // port, plugin-react 6.1) added 8.9 KiB Brotli to Home and 26.9 KiB to
    // the order page on 2026-10-07, past their budgets
    // (scripts/admin-perf-check.mjs). Retry when its output shrinks.
    viteReact(),
    tailwindcss(),
  ],
}));
