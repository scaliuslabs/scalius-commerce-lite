import { createFileRoute } from "@tanstack/react-router";

import { proxyAdminFlueComputerResult } from "./-result-proxy";

export const Route = createFileRoute("/api/assistant/flue/computer/results")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { env } = await import("cloudflare:workers");
        const futureEnv = env as Env & {
          ADMIN_FLUE_AGENT?: Fetcher;
          ADMIN_FLUE_AUTH_TOKEN?: string;
        };

        // Intentionally no authority resolver yet. The route remains fail-closed
        // until API-owned tenant/principal/thread admission is wired atomically
        // with the new Flue transcript transport.
        return proxyAdminFlueComputerResult(request, {
          agent: futureEnv.ADMIN_FLUE_AGENT,
          serviceToken: futureEnv.ADMIN_FLUE_AUTH_TOKEN,
        });
      },
    },
  },
});
