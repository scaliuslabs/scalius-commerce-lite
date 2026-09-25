import { defineMiddleware, sequence } from "astro:middleware";
import { env as cfEnv } from "cloudflare:workers";
import { hasStorefrontProductVariantSelectionParams } from "@scalius/shared/storefront-cache-path";
import {
  applyBaselineSecurityHeaders,
  redirectPlaintextRequest,
} from "@scalius/shared/http-security";

import {
  getRuntimeApiBaseUrl,
  getRuntimeCspAllowedDomains,
  getRuntimeMediaUrl,
  getRuntimeStorefrontUrl,
  runWithRequestRuntime,
} from "@/lib/api/runtime";
import { getLayoutData } from "@/lib/api/storefront";
import { getCdnBase } from "@/lib/media-url";
import {
  PRIVATE_NO_STORE_CACHE_CONTROL,
  isUncachedPrivateStorefrontPathname,
  renderOptedOutOfSharedCache,
  requestBypassesPublicStorefrontCache,
  requestHasPrivateSession,
} from "@/lib/cache-policy";
import { setPageCspHeader } from "@/lib/middleware-helper/csp-handler";
import {
  applyBrowserCachePolicyForPublicResponse,
  isSuccessfulPublicDiscoveryResponse,
} from "@/lib/public-discovery-cache";
import {
  applyPublicStorefrontPreconnectHint,
  getPublicStorefrontCachePolicy,
  isLayoutBatchedPagePath,
} from "@/lib/public-worker-cache";
import { BUILD_ID } from "@/config/build-id";
import { deferProductGlobalStylesheet } from "@/lib/product-style-delivery";
import {
  isBrowserContinuationRelayPathname,
} from "@/lib/browser-continuation-relay";

function getEnv(): Env | null {
  try {
    const env = cfEnv as Partial<Env> | null | undefined;
    if (env && (env.ASSETS || env.BACKEND_API || env.SCALIUS_SECRET)) {
      return cfEnv as unknown as Env;
    }
  } catch {
    // Local Astro development can run without Wrangler bindings.
  }
  return null;
}

function setPrivateResponse(response: Response, status: string): void {
  response.headers.set("Cache-Control", PRIVATE_NO_STORE_CACHE_CONTROL);
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");
  response.headers.set("X-Cache-Status", status);
}

const responsePolicyMiddleware = defineMiddleware(async (context, next) => {
  const { request, url } = context;
  const response = await next();
  // The CSP below needs the platform origins; pages already awaited this read.
  await getLayoutData();
  response.headers.set("X-Storefront-Build", BUILD_ID);
  const isGet = request.method === "GET" || request.method === "HEAD";
  const hasVariantSelection = hasStorefrontProductVariantSelectionParams(url);
  const hasPrivateSession = requestHasPrivateSession(request.headers);
  const bypassesPublicCache = requestBypassesPublicStorefrontCache(
    request.headers,
  );
  // The cart is private but a cacheable shell; checkout and the rest are not.
  const explicitlyPrivatePath = isUncachedPrivateStorefrontPathname(url.pathname);

  if (isGet && hasVariantSelection) {
    setPrivateResponse(response, "BYPASS_VARIANT_SELECTION");
  } else if (isGet && (bypassesPublicCache || explicitlyPrivatePath)) {
    setPrivateResponse(
      response,
      hasPrivateSession
        ? "BYPASS_AUTH"
        : explicitlyPrivatePath
          ? "NO_CACHE"
          : "BYPASS",
    );
  } else {
    const publicPolicy = getPublicStorefrontCachePolicy(request);
    const publicResponse =
      response.status === 200 &&
      !response.headers.has("Set-Cookie") &&
      !response.headers.has("set-cookie") &&
      (response.headers.get("Content-Type")?.toLowerCase().includes("text/html") ||
        isSuccessfulPublicDiscoveryResponse(response, url.pathname) ||
        (url.pathname === "/.well-known/ucp" &&
          response.headers.get("Content-Type")?.toLowerCase().includes("application/json")));

    if (publicPolicy && publicResponse && renderOptedOutOfSharedCache(response.headers)) {
      // The page rendered from a failed read (markRenderUncacheable): serve
      // it to this buyer only, never from the shared cache.
      setPrivateResponse(response, "BYPASS_DEGRADED");
    } else if (publicPolicy && publicResponse) {
      applyBrowserCachePolicyForPublicResponse(response, url.pathname);
      if (
        response.headers.get("Content-Type")?.toLowerCase().includes("text/html")
      ) {
        applyPublicStorefrontPreconnectHint(response, getCdnBase());
      }
      response.headers.set("X-Cache-Status", "MISS");
    } else if (!response.headers.has("Cache-Control")) {
      setPrivateResponse(response, "BYPASS");
    }
  }

  const securedResponse = isBrowserContinuationRelayPathname(url.pathname)
    ? response
    : setPageCspHeader(
        response,
        {
          apiBaseUrl: getRuntimeApiBaseUrl(),
          storefrontUrl: getRuntimeStorefrontUrl(),
          mediaUrl: getRuntimeMediaUrl(),
          cdnBaseUrl: getCdnBase(),
        },
        getRuntimeCspAllowedDomains(),
      );
  return deferProductGlobalStylesheet(securedResponse, url.pathname);
});

// Seeds the request-scoped runtime: derived secrets from SCALIUS_SECRET, then
// public origins and merchant CSP sources from the layout payload (applied
// when that read resolves). Storefront pages start the layout read together
// with their own reads, so the whole render is one API batch; every other
// route waits for the origins first. Nothing is read from Wrangler vars or
// import.meta.env, and nothing is retained across requests.
const requestRuntimeMiddleware = defineMiddleware(({ request, url }, next) =>
  runWithRequestRuntime(request, getEnv(), async () => {
    const layout = getLayoutData();
    const batchedPage =
      request.method === "GET" && isLayoutBatchedPagePath(url.pathname);
    if (!batchedPage) await layout;
    return next();
  }),
);

const transportSecurityMiddleware = defineMiddleware(
  async ({ request }, next) => {
    const redirect = redirectPlaintextRequest(request);
    if (redirect) return redirect;

    const privateRelay = isBrowserContinuationRelayPathname(new URL(request.url).pathname);
    const response = applyBaselineSecurityHeaders(request, await next(), {
      frameProtection: privateRelay ? "deny" : "same-origin",
    });
    if (privateRelay) response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  },
);

export const onRequest = sequence(
  transportSecurityMiddleware,
  requestRuntimeMiddleware,
  responsePolicyMiddleware,
);
