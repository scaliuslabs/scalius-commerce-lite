import { enableCompileCache } from "node:module";
import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

function fromRoot(path: string): string {
  return fileURLToPath(new URL(path, import.meta.url));
}

const adminSrc = fromRoot("./apps/admin-v2/src/");
const storefrontSrc = fromRoot("./apps/storefront/src/");
// Node's on-disk compile cache for this process and the forked test workers.
process.env.NODE_COMPILE_CACHE ??= fromRoot("./node_modules/.cache/node-compile");
enableCompileCache(process.env.NODE_COMPILE_CACHE);

// Side-effect-free packages: their test files share one module graph per worker.
const PURE_TESTS = [
  "packages/shared/**/*.test.?(c|m)[jt]s?(x)",
  "packages/plugin-sdk/**/*.test.?(c|m)[jt]s?(x)",
];
const cloudflareWorkersModuleId = "cloudflare:workers";
const resolvedCloudflareWorkersModuleId = "\0cloudflare-workers-vitest";

export default defineConfig({
  plugins: [
    {
      // Admin and storefront both map "@/" to their own src; resolve it by importer.
      name: "scalius-app-src-alias",
      enforce: "pre",
      resolveId(id, importer) {
        if (!id.startsWith("@/")) return undefined;
        const appSrc = importer?.includes("/apps/admin-v2/") ? adminSrc : storefrontSrc;
        return this.resolve(appSrc + id.slice(2), importer, { skipSelf: true });
      },
    },
    {
      name: "cloudflare-workers-vitest",
      resolveId(id) {
        if (id === cloudflareWorkersModuleId) {
          return resolvedCloudflareWorkersModuleId;
        }
        return undefined;
      },
      load(id) {
        if (id === resolvedCloudflareWorkersModuleId) {
          return "export const env = {}; export class WorkerEntrypoint {};";
        }
        return undefined;
      },
    },
  ],
  resolve: {
    alias: {
      "~/": adminSrc,
    },
  },
  test: {
    globals: true,
    exclude: [...configDefaults.exclude, ".claude/**"],
    // Transformed modules persist in node_modules/.vitest-cache between runs.
    fsModuleCache: true,
    projects: [
      {
        extends: true,
        test: {
          name: "pure",
          include: PURE_TESTS,
          // No per-file module reset: these modules hold no state. Globals and
          // env stubs are still undone after every test.
          isolate: false,
          unstubGlobals: true,
          unstubEnvs: true,
        },
      },
      {
        extends: true,
        test: {
          name: "app",
          exclude: [...configDefaults.exclude, ".claude/**", ...PURE_TESTS],
        },
      },
    ],
  },
});
