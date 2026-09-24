import { handle } from "@astrojs/cloudflare/handler";
import { WorkerEntrypoint } from "cloudflare:workers";

import { readCacheGenerationHint } from "@scalius/shared/cache-generation";
import { servePublicStorefrontRequest } from "./lib/public-worker-cache";
import { httpsRedirectResponse } from "./lib/storefront-origin";
import { BUILD_ID } from "./config/build-id";
import {
  RUNTIME_SECRET_PURPOSES,
  deriveRuntimeSecret,
  readMasterSecret,
} from "@scalius/shared/runtime-secrets";
import {
  FRONT_PROXY_SIGNATURE_HEADER,
  applyTrustedFrontProxy,
} from "@scalius/shared/trusted-front-proxy";

/**
 * Honours a signed front proxy's forwarded host, proto, and client IP. The
 * signing secret is derived from the master secret only when the signature
 * header is present; an unsigned or invalid header changes nothing and the
 * header never reaches the renderer.
 */
async function resolveFrontProxy(request: Request, env: Env): Promise<Request> {
  if (!request.headers.has(FRONT_PROXY_SIGNATURE_HEADER)) return request;
  const master = readMasterSecret(env);
  const secret = master
    ? await deriveRuntimeSecret(master, RUNTIME_SECRET_PURPOSES.FRONT_PROXY_SECRET)
    : null;
  const resolved = (await applyTrustedFrontProxy(request, secret)).request;
  const stripped = new Request(resolved);
  stripped.headers.delete(FRONT_PROXY_SIGNATURE_HEADER);
  return stripped;
}

export default class StorefrontGateway extends WorkerEntrypoint<Env> {
  async fetch(incoming: Request): Promise<Response> {
    const request = await resolveFrontProxy(incoming, this.env);
    const httpsRedirect = httpsRedirectResponse(request);
    if (httpsRedirect) return httpsRedirect;
    return servePublicStorefrontRequest(request, {
      cache: caches.default,
      readGeneration: () => readCacheGenerationHint(this.env.CACHE),
      buildId: BUILD_ID,
      render: (renderRequest) => handle(renderRequest, this.env, this.ctx),
      waitUntil: (promise) => this.ctx.waitUntil(promise),
    });
  }
}
