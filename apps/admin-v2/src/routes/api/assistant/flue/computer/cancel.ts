import { createFileRoute } from "@tanstack/react-router";

import { createAdminFlueAuthorityResolver } from "./-authority";
import { proxyAdminFlueComputerCancellation } from "./-result-proxy";

export const Route = createFileRoute("/api/assistant/flue/computer/cancel")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { env } = await import("cloudflare:workers");
        const futureEnv = env as Env & {
          ADMIN_FLUE_AGENT?: Fetcher;
          ADMIN_FLUE_AUTH_TOKEN?: string;
        };

        return proxyAdminFlueComputerCancellation(request, {
          agent: futureEnv.ADMIN_FLUE_AGENT,
          serviceToken: futureEnv.ADMIN_FLUE_AUTH_TOKEN,
          resolveAuthority: createAdminFlueAuthorityResolver({
            api: futureEnv.API,
          }),
        });
      },
    },
  },
});
