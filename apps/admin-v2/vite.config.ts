import { defineConfig, type Plugin } from "vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { adminChunkGraphPlugin } from "../../scripts/admin-chunk-graph.mjs";
import { adminSdkOperationsPlugin, isSdkOperationChunk } from "../../scripts/admin-sdk-operations.mjs";
import { devOrigins, platformOriginPresenter, readDevPorts } from "../../scripts/dev-ports.mjs";
import { CAMERA_PERMISSIONS_POLICY, PERMISSIONS_POLICY, dashboardDocumentCsp } from "../../packages/shared/src/http-security";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * The dashboard is a static single-page app. `vite build` writes `dist/`,
 * which the API Worker serves as its `ASSETS` binding (apps/api/wrangler.jsonc)
 * on the dashboard hostname. Locally, `vite dev` serves it on the admin port
 * and proxies the API Worker's dashboard routes to the API port (both from
 * scripts/dev-ports.mjs: SCALIUS_DEV_ADMIN_PORT and SCALIUS_DEV_API_PORT).
 */
const devPorts = readDevPorts();
const API_DEV_ORIGIN = devOrigins(devPorts).apiUrl;

/**
 * Dashboard UI preview (docs/ADMIN-QUALITY.md): this dev server may run on a
 * port other than the one in the API's Platform settings (a worktree's
 * dashboard against another stack's API). The API trusts only the Platform
 * dashboard origin, so the proxy presents that origin for requests that carry
 * an Origin (sign-in, writes, the realtime socket), read fresh from the API
 * for each of them, so a Platform change never needs a dev-server restart.
 * Vite awaits `bypass` before it proxies a request or a socket upgrade. Dev
 * server only; loopback origins only (`previewProxyOrigin`); the API is unchanged.
 */
const presentPlatformOrigin = platformOriginPresenter({ apiOrigin: API_DEV_ORIGIN });
function apiProxy(target: string) {
  return {
    target,
    changeOrigin: true,
    async bypass(request: { headers: Record<string, string | string[] | undefined> }) {
      await presentPlatformOrigin(request.headers);
      return undefined;
    },
  };
}

/**
 * `vite dev` serves the dashboard document itself, so it states the policy
 * the API Worker states in production (apps/api/src/dashboard/surface.ts),
 * from the same builder over the shell it serves: Vite's own inline scripts
 * are hashed like the shell's, and a script the policy would block in
 * production is blocked here first. Its one addition is the update socket.
 */
function dashboardDocumentPolicy(): Plugin {
  const policies = new Map<string, string>();
  const origins = devOrigins(devPorts);
  return {
    name: "scalius:dashboard-document-policy",
    apply: "serve",
    transformIndexHtml: {
      order: "post",
      async handler(html, context) {
        policies.set(context.originalUrl ?? context.path, await dashboardDocumentCsp(html, {
          documentOrigin: origins.dashboardUrl,
          storefrontUrl: origins.storefrontUrl,
          mediaUrl: origins.mediaUrl,
          developmentSocketOrigins: [origins.dashboardUrl.replace(/^http/, "ws")],
        }));
        return html;
      },
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const key = request.originalUrl ?? request.url ?? "";
        const end = response.end.bind(response) as (...args: unknown[]) => typeof response;
        response.end = ((...args: unknown[]) => {
          const policy = policies.get(key);
          if (policy && !response.headersSent) {
            policies.delete(key);
            response.setHeader("Content-Security-Policy", policy);
            response.setHeader("Permissions-Policy", /^\/scanner(?:[/?#]|$)/.test(key) ? CAMERA_PERMISSIONS_POLICY : PERMISSIONS_POLICY);
          }
          return end(...args);
        }) as typeof response.end;
        next();
      });
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
        // 24 KiB merge threshold made two bundles of all of them; 8 KiB still
        // folded unrelated screens' icons into each route, 1–2 KiB a route,
        // reshuffled by any new import; 2 KiB keeps groups per screen set). One
        // unsplit initial group keeps the router's strongly connected
        // runtime together.
        // An icon payload is named by every screen that shares it
        // (`admin-icons~orders~products~…`), and each lazy import lists the
        // files it needs by name: those names alone cost every route kilobytes.
        // A content hash already makes each file unique.
        // Chunks of API operations shared by several screens are named alike
        // for the same reason (scripts/admin-sdk-operations.mjs).
        chunkFileNames: (chunk) =>
          `assets/immutable/${chunk.name.startsWith("admin-icons~") ? "admin-icons" : isSdkOperationChunk(chunk.name) ? "admin-sdk" : "[name]"}-[hash].js`,
        codeSplitting: {
          groups: [
            { name: "admin-shell", tags: ["$initial"], priority: 100 },
            {
              name: "admin-icons",
              test: /node_modules[\\/]lucide-react/,
              priority: 50,
              entriesAware: true,
              entriesAwareMergeThreshold: 2 * 1024,
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
    dashboardDocumentPolicy(),
    adminSdkOperationsPlugin(),
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
    // Records the build's chunk graph beside the Vite cache so scripts/admin-perf-check.mjs
    // measures this build instead of building the dashboard again.
    adminChunkGraphPlugin(),
  ],
}));
