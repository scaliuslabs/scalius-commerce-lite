import { defineConfig } from "vitest/config";

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
  test: {
    globals: true,
    environment: "happy-dom",
  },
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
});
