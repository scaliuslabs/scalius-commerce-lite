import { handle } from "@astrojs/cloudflare/handler";
import { WorkerEntrypoint } from "cloudflare:workers";

import {
  decoratePublicStorefrontResponse,
  exposePublicStorefrontResponse,
  getPublicStorefrontCachePolicy,
  normalizePublicStorefrontCacheTags,
  recoverCurrentStorefrontBuild,
} from "./lib/public-worker-cache";
import { BUILD_ID } from "./config/build-id";
import { toPublicCacheRequest } from "./lib/cache-policy";
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

export class CachedPublicStorefront extends WorkerEntrypoint<Env> {
  async fetch(incoming: Request): Promise<Response> {
    const request = await resolveFrontProxy(incoming, this.env);
    const policy = getPublicStorefrontCachePolicy(request);
    if (!policy) {
      return new Response("Request is not eligible for public caching", {
        status: 400,
        headers: { "Cache-Control": "private, no-store" },
      });
    }

    const response = await handle(request, this.env, this.ctx);
    return decoratePublicStorefrontResponse(response, policy);
  }

  async purgeGroups(groups: string[]): Promise<void> {
    const tags = normalizePublicStorefrontCacheTags(groups);
    if (tags.length === 0) return;

    const cache = this.ctx.cache;
    if (!cache) return;

    const result = await cache.purge({ tags });
    if (!result.success) {
      const codes = result.errors.map((error) => error.code).join(",");
      throw new Error(
        `Public storefront cache purge failed (${codes || "unknown"})`,
      );
    }
  }
}

export default class StorefrontGateway extends WorkerEntrypoint<Env> {
  async fetch(incoming: Request): Promise<Response> {
    const request = await resolveFrontProxy(incoming, this.env);
    const policy = getPublicStorefrontCachePolicy(request);
    if (!policy) return handle(request, this.env, this.ctx);

    const cacheRequest = toPublicCacheRequest(request, policy.canonicalUrl);
    const response = await this.ctx.exports.CachedPublicStorefront.fetch(
      cacheRequest,
    );

    // Versioned native cache entries should be isolated by Cloudflare. Keep a
    // defensive recovery path because a stale entry must never survive a
    // successful deployment or expose HTML that references superseded assets.
    const currentResponse = await recoverCurrentStorefrontBuild({
      response,
      expectedBuildId: BUILD_ID,
      purge: () =>
        this.ctx.exports.CachedPublicStorefront.purgeGroups([...policy.tags]),
      refetch: () => this.ctx.exports.CachedPublicStorefront.fetch(cacheRequest),
      // A repeated mismatch must not expose stale HTML. Bypass the native lane
      // and render through the currently executing Worker as the bounded fallback.
      renderDirect: () => handle(request, this.env, this.ctx),
    });

    return exposePublicStorefrontResponse(currentResponse);
  }
}
