import { createFileRoute } from "@tanstack/react-router";

import { createAdminFlueAuthorityResolver } from "../computer/-authority";
import { proxyAdminFlueAgentFacade } from "./-facade";

async function handleAdminFlueAgentRequest(request: Request): Promise<Response> {
  const { env } = await import("cloudflare:workers");
  const futureEnv = env as Env & {
    ADMIN_FLUE_AGENT?: Fetcher;
    ADMIN_FLUE_AUTH_TOKEN?: string;
  };

  return proxyAdminFlueAgentFacade(request, {
    agent: futureEnv.ADMIN_FLUE_AGENT,
    api: futureEnv.API,
    serviceToken: futureEnv.ADMIN_FLUE_AUTH_TOKEN,
    resolveAuthority: createAdminFlueAuthorityResolver({ api: futureEnv.API }),
  });
}

export const Route = createFileRoute("/api/assistant/flue/agents/$")({
  server: {
    handlers: {
      GET: async ({ request }) => handleAdminFlueAgentRequest(request),
      POST: async ({ request }) => handleAdminFlueAgentRequest(request),
    },
  },
});
