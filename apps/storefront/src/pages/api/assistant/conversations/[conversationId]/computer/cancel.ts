import type { APIRoute } from "astro";
import { env as cfEnv } from "cloudflare:workers";

import { proxyStorefrontFlueComputerCancellation } from "@/lib/storefront-flue-computer-result-proxy";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  let runtimeEnv: Partial<Env>;
  try {
    runtimeEnv = cfEnv as Partial<Env>;
  } catch {
    runtimeEnv = {};
  }
  const serviceToken =
    typeof runtimeEnv.STOREFRONT_FLUE_AUTH_TOKEN === "string"
      ? runtimeEnv.STOREFRONT_FLUE_AUTH_TOKEN
      : undefined;

  return proxyStorefrontFlueComputerCancellation(request, {
    backend: runtimeEnv.BACKEND_API,
    agent: runtimeEnv.STOREFRONT_FLUE_AGENT,
    serviceToken,
  });
};
