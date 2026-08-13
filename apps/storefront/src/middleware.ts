import { defineMiddleware, sequence } from "astro:middleware";
import { env as cfEnv } from "cloudflare:workers";
import { hasStorefrontProductVariantSelectionParams } from "@scalius/shared/storefront-cache-path";
import {
  applyBaselineSecurityHeaders,
  redirectPlaintextRequest,
} from "@scalius/shared/http-security";

import { apiContext } from "@/lib/api/context";
import {
  isPrivateStorefrontPathname,
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
} from "@/lib/public-worker-cache";
import { BUILD_ID } from "@/config/build-id";
import { deferProductGlobalStylesheet } from "@/lib/product-style-delivery";
import {
  isBrowserContinuationRelayPathname,
  isForbiddenStorefrontCrossOriginFormRequest,
} from "@/lib/browser-continuation-relay";

function getEnv(): Env | null {
  try {
    const env = cfEnv as Partial<Env> | null | undefined;
    if (env && (env.ASSETS || env.CDN_DOMAIN_URL || env.PUBLIC_API_URL)) {
      return cfEnv as unknown as Env;
    }
  } catch {
    // Local Astro development can run without Wrangler bindings.
  }
  return null;
}

function setPrivateResponse(response: Response, status: string): void {
  response.headers.set(
    "Cache-Control",
    "private, no-cache, no-store, must-revalidate",
  );
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");
  response.headers.set("X-Cache-Status", status);
}

const responsePolicyMiddleware = defineMiddleware(async (context, next) => {
  const { request, url } = context;
  const response = await next();
  const env = getEnv();
  response.headers.set("X-Storefront-Build", BUILD_ID);
  const isGet = request.method === "GET" || request.method === "HEAD";
  const hasVariantSelection = hasStorefrontProductVariantSelectionParams(url);
  const hasPrivateSession = requestHasPrivateSession(request.headers);
  const bypassesPublicCache = requestBypassesPublicStorefrontCache(
    request.headers,
  );
  const explicitlyPrivatePath = isPrivateStorefrontPathname(url.pathname);

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

    if (publicPolicy && publicResponse) {
      applyBrowserCachePolicyForPublicResponse(response, url.pathname);
      if (
        response.headers.get("Content-Type")?.toLowerCase().includes("text/html")
      ) {
        applyPublicStorefrontPreconnectHint(response, env?.CDN_DOMAIN_URL);
      }
      response.headers.set("X-Cache-Status", "NATIVE");
    } else if (!response.headers.has("Cache-Control")) {
      setPrivateResponse(response, "BYPASS");
    }
  }

  const securedResponse = isBrowserContinuationRelayPathname(url.pathname)
    ? response
    : await setPageCspHeader(response, env ?? undefined);
  return deferProductGlobalStylesheet(securedResponse, url.pathname);
});

const apiContextMiddleware = defineMiddleware((_context, next) => {
  const env = getEnv();
  let cdnDomain = env?.CDN_DOMAIN_URL as string | undefined;
  if (!cdnDomain) {
    try {
      cdnDomain = (cfEnv as Partial<Env> | null | undefined)?.CDN_DOMAIN_URL;
    } catch {
      // Wrangler bindings are unavailable in local Astro development.
    }
  }

  return apiContext.run(
    {
      BACKEND_API: env?.BACKEND_API as Fetcher | undefined,
      PUBLIC_API_URL: env?.PUBLIC_API_URL as string | undefined,
      PUBLIC_API_BASE_URL: env?.PUBLIC_API_BASE_URL as string | undefined,
      CDN_DOMAIN_URL: cdnDomain,
      STOREFRONT_URL: env?.STOREFRONT_URL as string | undefined,
      API_TOKEN: env?.API_TOKEN as string | undefined,
      inflightReads: new Map<string, Promise<unknown>>(),
      apiJwt: { token: null, expiresAt: null, refresh: null },
    },
    next,
  );
});

const transportSecurityMiddleware = defineMiddleware(
  async ({ request }, next) => {
    const redirect = redirectPlaintextRequest(request);
    if (redirect) return redirect;

    const privateRelay = isBrowserContinuationRelayPathname(new URL(request.url).pathname);
    if (!privateRelay && isForbiddenStorefrontCrossOriginFormRequest(request)) {
      return new Response(`Cross-site ${request.method} form submissions are forbidden`, {
        status: 403,
      });
    }
    const response = applyBaselineSecurityHeaders(request, await next(), {
      frameProtection: privateRelay ? "deny" : "same-origin",
    });
    if (privateRelay) response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  },
);

export const onRequest = sequence(
  transportSecurityMiddleware,
  apiContextMiddleware,
  responsePolicyMiddleware,
);
