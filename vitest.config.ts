import { readFileSync } from "node:fs";
import { enableCompileCache } from "node:module";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

import { SERIAL_TESTS, testPass } from "./scripts/test-passes.mjs";

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
// `pnpm test` runs two passes (`scripts/test-passes.mjs`): the parallel pass
// leaves the serial files out, the serial pass collects only them.
const pass = testPass();
// Test processes: half the cores, two to six (a 16 GB host shares them with
// typechecks and other agents; each app fork holds migrated D1 images and a
// DOM). `SCALIUS_TEST_WORKERS` overrides it; `--maxWorkers` wins over both.
const testWorkers = Number(process.env.SCALIUS_TEST_WORKERS) || Math.min(6, Math.max(2, Math.floor(availableParallelism() / 2)));
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
      // A `*.txt` import is its text, as Wrangler bundles it (a Text module);
      // Vite would hand over an asset URL.
      name: "scalius-text-modules",
      enforce: "pre",
      load(id) {
        if (!id.endsWith(".txt")) return undefined;
        return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
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
          return "export const env = {}; export class WorkerEntrypoint {}; export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }";
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
    maxWorkers: testWorkers,
    // One limit sized for a loaded host, instead of per-file overrides. A
    // test that is long by design (a property or race gate, a scale run)
    // keeps its own, larger limit.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The OAuth provider imports `cloudflare:workers`; inline it so the stub above resolves.
    server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
    // Frozen review copies and agent checkouts are not source test suites.
    exclude: [...configDefaults.exclude, ".claude/**", "audit/**"],
    // Transformed modules persist in node_modules/.vitest-cache between runs.
    fsModuleCache: true,
    // Each run records the modules every test file loaded, so `--changed`
    // (`pnpm test:affected`, scripts/test-affected.mjs) selects by what a test
    // really imports instead of walking the static graph.
    experimental: { recordDependencies: true },
    projects: [
      ...(pass === "serial"
        ? []
        : [
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
          ]),
      {
        extends: true,
        test: {
          name: "app",
          ...(pass === "serial" ? { include: SERIAL_TESTS } : {}),
          exclude: [
            ...configDefaults.exclude,
            ".claude/**",
            "audit/**",
            ...PURE_TESTS,
            ...(pass === "parallel" ? SERIAL_TESTS : []),
          ],
          // Every migrated D1/Turso image the suite asks for, built once for
          // all test processes; the storefront's generated build id.
          globalSetup: [
            "./packages/database/src/testing/migrated-image-setup.ts",
            "./apps/storefront/scripts/test-build-id-setup.mjs",
          ],
        },
      },
    ],
  },
});
