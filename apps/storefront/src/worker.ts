import { handle } from "@astrojs/cloudflare/handler";
import { WorkerEntrypoint } from "cloudflare:workers";

import {
  decoratePublicStorefrontResponse,
  exposePublicStorefrontResponse,
  getPublicStorefrontCachePolicy,
  normalizePublicStorefrontCacheTags,
} from "./lib/public-worker-cache";

export class PublicStorefront extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
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

    const result = await this.ctx.cache.purge({ tags });
    if (!result.success) {
      const codes = result.errors.map((error) => error.code).join(",");
      throw new Error(
        `Public storefront cache purge failed (${codes || "unknown"})`,
      );
    }
  }
}

export default class StorefrontGateway extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const policy = getPublicStorefrontCachePolicy(request);
    if (!policy) return handle(request, this.env, this.ctx);

    const cacheRequest = policy.canonicalUrl === request.url
      ? request
      : new Request(policy.canonicalUrl, request);
    const response = await this.ctx.exports.PublicStorefront.fetch(cacheRequest);
    return exposePublicStorefrontResponse(response);
  }
}
