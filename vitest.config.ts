import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

function fromRoot(path: string): string {
  return fileURLToPath(new URL(path, import.meta.url));
}

const adminSrc = fromRoot("./apps/admin-v2/src/");
const storefrontSrc = fromRoot("./apps/storefront/src/");
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
  },
});
