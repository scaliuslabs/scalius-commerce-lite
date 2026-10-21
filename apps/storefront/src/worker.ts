import { handle } from "@astrojs/cloudflare/handler";
import { WorkerEntrypoint } from "cloudflare:workers";

import { readWorkerVersion } from "@scalius/shared/cache-generation";
import {
  STOREFRONT_PAGE_CACHE_MODE,
  servePublicStorefrontRequest,
} from "./lib/public-worker-cache";
import { createCacheFrontierClient, type CacheFrontierClient } from "./lib/cache-frontier";
import { CACHE_FRONTIER_SECRET_PURPOSE } from "@scalius/shared/cache-frontier";
import { INTERNAL_SERVICE_ORIGIN } from "@scalius/shared/platform-config";
import { httpsRedirectResponse } from "./lib/storefront-origin";
import { runWithWorkerEnv } from "./lib/api/runtime";
import { serveExtensionFile } from "./lib/extensions/files";
import { serveStorefrontMedia } from "./lib/media-proxy";
import { oneClickUnsubscribeRequest } from "./lib/newsletter-one-click";
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
import type { MarketMatrix } from "@scalius/shared/markets";
import {
  localizePresenceResponse,
  marketChoiceRedirect,
  presenceRenderTarget,
  withoutInboundPresence,
} from "./lib/market-presence";
import { withAppFormTokens } from "./lib/app-form-tokens";
import { listingFilterRedirect } from "./lib/listing-filter-redirect";

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

/**
 * The frontier API over the service binding (frontier mode only). The key is
 * derived once per request that needs it; without the binding or the master
 * secret there is no client and pages render uncached.
 */
function frontierClient(env: Env): CacheFrontierClient | null {
  const backend = env.BACKEND_API;
  const master = readMasterSecret(env);
  if (STOREFRONT_PAGE_CACHE_MODE !== "frontier" || !backend || !master) return null;
  let key: Promise<string> | null = null;
  return createCacheFrontierClient(
    (request) => backend.fetch(request),
    INTERNAL_SERVICE_ORIGIN,
    () => (key ??= deriveRuntimeSecret(master, CACHE_FRONTIER_SECRET_PURPOSE)),
  );
}

/**
 * The active presence matrix from the API (a validated public read), for a
 * buyer's market choice. Null when it cannot be read: no redirect then.
 */
async function readMarketMatrix(env: Env): Promise<MarketMatrix | null> {
  if (!env.BACKEND_API) return null;
  const response = await env.BACKEND_API.fetch(new Request(`${INTERNAL_SERVICE_ORIGIN}/api/v1/storefront/markets`, {
    headers: { Accept: "application/json" },
  }));
  if (!response.ok) return null;
  const envelope = await response.json() as { data?: MarketMatrix };
  return Array.isArray(envelope.data?.markets) ? envelope.data! : null;
}

const PRESENCE_NOT_FOUND = () => new Response("Not Found", {
  status: 404,
  headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, no-store" },
});

export default class StorefrontGateway extends WorkerEntrypoint<Env> {
  async fetch(incoming: Request): Promise<Response> {
    // Only this gateway names a render's market presence.
    const request = withoutInboundPresence(await resolveFrontProxy(incoming, this.env));
    const httpsRedirect = httpsRedirectResponse(request);
    if (httpsRedirect) return httpsRedirect;
    // An app's storefront files (immutable, by release): no page render.
    const extensionFile = await serveExtensionFile(request, this.env);
    if (extensionFile) return extensionFile;
    // The store's media on its own origin (immutable, from R2 via the API):
    // no page render, no layout read.
    const media = await serveStorefrontMedia(request, {
      env: this.env,
      workerVersion: readWorkerVersion(this.env),
      waitUntil: (promise) => this.ctx.waitUntil(promise),
    });
    if (media) return media;
    // A presence serves its pages and its own sitemaps and feeds, nothing else.
    if (presenceRenderTarget(request) === "not_found") return PRESENCE_NOT_FOUND();
    // A listing's filter form posts (so crawlers cannot enumerate it): answer
    // with the GET listing URL it describes, before any render.
    const filtered = await listingFilterRedirect(request);
    if (filtered) return filtered;
    // A buyer's explicit market choice; never geo, never a crawler.
    const choice = await marketChoiceRedirect(request, () => readMarketMatrix(this.env));
    if (choice) return choice;
    // A mail client's RFC 8058 one-click unsubscribe (no Origin, a form
    // body) reaches the unsubscribe page as JSON; everything else as sent.
    const oneClick = await oneClickUnsubscribeRequest(request);
    const response = await servePublicStorefrontRequest(oneClick ?? request, {
      cache: caches.default,
      buildId: BUILD_ID,
      workerVersion: readWorkerVersion(this.env),
      render: (renderRequest) => this.render(renderRequest),
      waitUntil: (promise) => this.ctx.waitUntil(promise),
      frontier: frontierClient(this.env),
    });
    // A signed-in buyer's page: the platform's token in every app POST form
    // (after the page cache, which never holds a signed-in page).
    return withAppFormTokens(request, response, this.env);
  }

  /**
   * A presence URL renders its page from the one route tree; the response is
   * localized before it is stored. A root URL renders exactly as before.
   */
  private async render(renderRequest: Request): Promise<Response> {
    const target = presenceRenderTarget(renderRequest);
    if (target === "not_found") return PRESENCE_NOT_FOUND();
    if (!target) return runWithWorkerEnv(this.env, () => handle(renderRequest, this.env, this.ctx));
    const response = await runWithWorkerEnv(this.env, () => handle(target.render, this.env, this.ctx));
    return localizePresenceResponse(response, target.presence, new URL(renderRequest.url).origin);
  }
}
