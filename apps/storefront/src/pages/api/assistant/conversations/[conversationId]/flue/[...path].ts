import type { APIRoute } from "astro";
import { env as cfEnv } from "cloudflare:workers";

import { proxyStorefrontFlueAgentFacade } from "@/lib/storefront-flue-agent-facade";

export const prerender = false;

function proxy(request: Request): Promise<Response> {
  let runtimeEnv: Partial<Env>;
  try {
    runtimeEnv = cfEnv as Partial<Env>;
  } catch {
    runtimeEnv = {};
  }
  return proxyStorefrontFlueAgentFacade(request, {
    backend: runtimeEnv.BACKEND_API,
    agent: runtimeEnv.STOREFRONT_FLUE_AGENT,
    serviceToken:
      typeof runtimeEnv.STOREFRONT_FLUE_AUTH_TOKEN === "string"
        ? runtimeEnv.STOREFRONT_FLUE_AUTH_TOKEN
        : undefined,
  });
}

export const GET: APIRoute = ({ request }) => proxy(request);
export const POST: APIRoute = ({ request }) => proxy(request);
