import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

function fromRoot(path: string): string {
  return fileURLToPath(new URL(path, import.meta.url));
}

const cloudflareWorkersModuleId = "cloudflare:workers";
const resolvedCloudflareWorkersModuleId = "\0cloudflare-workers-vitest";

export default defineConfig({
  plugins: [
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
      "@/": fromRoot("./apps/storefront/src/"),
      "~/": fromRoot("./apps/admin-v2/src/"),
    },
  },
  test: {
    globals: true,
  },
});
