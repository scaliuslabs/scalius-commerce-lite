import { defineMiddleware, sequence } from "astro:middleware";
import { redirectPlaintextRequest } from "@scalius/shared/http-security";
import { applyTransportSecurityHeaders, withPageCsp } from "@/lib/middleware-helper/private-download-security";

import {
  getRuntimeApiBaseUrl,
  getRuntimeCspAllowedDomains,
  getRuntimeDashboardUrl,
  getRuntimeMediaUrl,
  getRuntimePresence,
  getRuntimeStorefrontUrl,
  getWorkerEnv,
  runWithRequestRuntime,
} from "@/lib/api/runtime";
import { marketOfPresence } from "@scalius/shared/markets";
import { getLayoutData } from "@/lib/api/storefront";
import { getCdnBase, getSameOriginMediaSource } from "@/lib/media-url";
import {
  PRIVATE_NO_STORE_CACHE_CONTROL,
  isUncachedPrivateStorefrontPathname,
  renderOptedOutOfSharedCache,
  requestBypassesPublicStorefrontCache,
  requestHasPrivateSession,
} from "@/lib/cache-policy";
import { setPageCspHeader } from "@/lib/middleware-helper/csp-handler";
import { isPaymentPage, storeScriptSources } from "@/lib/analytics-csp";
import { storefrontInlineScriptHashes } from "@/lib/inline-script-policy";
import { appComponentsRenderOn, appScriptOrigins, appScriptsForPage, storefrontAppPage } from "@/lib/app-scripts";
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
import {
  isBrowserContinuationRelayPathname,
  isFramedBrowserContinuationRelayPathname,
} from "@/lib/browser-continuation-relay";
import { themeEditorOrigin } from "@scalius/shared/theme-editor-bridge";
import { currentRequestTheme, pageRendersDegradedTheme, resolveRequestTheme } from "@/lib/storefront-theme-context";
import { readStorefrontExtensions } from "@scalius/shared/plugins/storefront-components";
import { themeAppConnectHosts } from "@/lib/extensions/stylesheets";
import { appendClearThemePreviewCookies, readThemePreviewCookie, THEME_PREVIEW_COOKIE_NAME } from "@/lib/theme-preview-cookie";
import { catalogRedirectBeforeReads } from "@/lib/listing-url-redirect";
import { presenceOfRenderRequest } from "@/lib/market-presence";
import { buyerPageForbidsFraming } from "@/lib/middleware-helper/buyer-page-framing";
import { themePreviewBuyerPageNotice } from "@/lib/middleware-helper/theme-preview-buyer-page";
import { isBuyerOwnPagePath } from "@/lib/theme-preview-route";

interface PreviewFramingLocals {
  /**
   * The answer is a valid theme preview's, which the dashboard may frame: the
   * page it rendered (set by the response policy), or the notice it shows in
   * place of a buyer's own page.
   */
  themePreviewRender?: boolean;
}

/**
 * Who besides the storefront may frame this page: the dashboard (Platform
 * settings), only when the HTML rendered a valid theme preview. A request
 * without the preview cookie (every buyer's) is never even checked; with
 * one, the page's own preview resolution is reused. A page drawn under a
 * preview the API says has ended (expired, revoked or unknown) drops the
 * cookie here: a layout cannot, as a streamed page's headers leave before it
 * renders. Without an answer (a timeout, 429 or 5xx) the cookie stays and the
 * next page asks again. Either way the response is private (the cookie
 * bypasses the shared cache). A buyer's own page is never a preview, so the
 * dashboard never frames it, whatever the request.
 */
async function themePreviewFrameAncestors(
  context: { request: Request; url: URL; locals: object },
  response: Response,
): Promise<string[]> {
  if (!readThemePreviewCookie(context.request.headers.get("cookie"))) return [];
  if (isBuyerOwnPagePath(context.url.pathname)) return [];
  if (!response.headers.get("Content-Type")?.toLowerCase().includes("text/html")) return [];
  try {
    const theme = await resolveRequestTheme(context, await getLayoutData());
    if (!theme.preview) {
      if (theme.previewEnded && !setsThemePreviewCookie(response.headers)) appendClearThemePreviewCookies(response.headers);
      return [];
    }
    (context.locals as PreviewFramingLocals).themePreviewRender = true;
    const dashboard = themeEditorOrigin(getRuntimeDashboardUrl());
    return dashboard ? [dashboard] : [];
  } catch {
    return [];
  }
}

/** The page already set or cleared the preview cookie itself (`/theme-preview`). */
function setsThemePreviewCookie(headers: Headers): boolean {
  return headers.getSetCookie().some((cookie) => cookie.startsWith(`${THEME_PREVIEW_COOKIE_NAME}=`));
}

function getEnv(): Env | null {
  try {
    const env = getWorkerEnv<Partial<Env>>();
    if (env && (env.ASSETS || env.BACKEND_API || env.SCALIUS_SECRET)) {
      return env as Env;
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
  const { request, url, locals } = context;
  const response = await next();
  // The CSP below needs the platform origins and the app scripts the page
  // loads; pages already awaited this read.
  const layout = await getLayoutData();
  // A subfolder presence no active market holds is not a page (MARKETS-DESIGN
  // D4): the URL alone decides, so it is a 404 for every buyer. Astro renders
  // the 404 page for this empty answer; that render is left alone.
  const presence = getRuntimePresence();
  if (
    presence && layout && !marketOfPresence(layout.markets ?? { markets: [] }, presence)
    && context.routePattern !== "/404" && context.routePattern !== "/500"
  ) {
    await response.body?.cancel().catch(() => undefined);
    return new Response(null, { status: 404, headers: { "Cache-Control": PRIVATE_NO_STORE_CACHE_CONTROL } });
  }
  response.headers.set("X-Storefront-Build", BUILD_ID);
  const isGet = request.method === "GET" || request.method === "HEAD";
  const hasPrivateSession = requestHasPrivateSession(request.headers);
  const bypassesPublicCache = requestBypassesPublicStorefrontCache(
    request.headers,
  );
  // The cart and checkout are private but cacheable shells; the rest are not.
  const explicitlyPrivatePath = isUncachedPrivateStorefrontPathname(url.pathname);

  if (isGet && (bypassesPublicCache || explicitlyPrivatePath)) {
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

    if (
      publicPolicy && publicResponse
      && (renderOptedOutOfSharedCache(response.headers) || await pageRendersDegradedTheme({ request, locals }, response, layout))
    ) {
      // The page rendered from a failed read (markRenderUncacheable) or drew
      // the default theme in place of an unreadable one: serve it to this
      // buyer only, never from the shared cache.
      setPrivateResponse(response, "BYPASS_DEGRADED");
    } else if (publicPolicy && publicResponse) {
      applyBrowserCachePolicyForPublicResponse(response, url.pathname);
      if (
        response.headers.get("Content-Type")?.toLowerCase().includes("text/html")
      ) {
        // Media on the store's own origin needs no hint for a second host.
        applyPublicStorefrontPreconnectHint(response, getSameOriginMediaSource() ? null : getCdnBase());
      }
      response.headers.set("X-Cache-Status", "MISS");
    } else if (!response.headers.has("Cache-Control")) {
      setPrivateResponse(response, "BYPASS");
    }
  }

  // A theme preview may be framed by the dashboard's editor; a buyer's page never.
  const frameAncestors = await themePreviewFrameAncestors({ request, url, locals }, response);
  // The theme the page drew (the draft in a preview) names the apps whose hosts may be reached;
  // none on a buyer's page, where app components never render.
  const themeConnectHosts = themeAppConnectHosts(
    (await currentRequestTheme(locals)).theme,
    appComponentsRenderOn(storefrontAppPage(url.pathname)) ? readStorefrontExtensions(layout?.appExtensions) : [],
    url.pathname,
  );
  // Every inline script the page can run is known now, before its body renders:
  // the storefront's own (constant code) and the store's saved scripts (from the
  // layout read). A payment page marked itself in its frontmatter and runs no store script.
  const paymentPage = isPaymentPage(locals);
  const [inlineScriptHashes, storeScripts] = await Promise.all([
    storefrontInlineScriptHashes(),
    paymentPage ? null : storeScriptSources(layout?.analytics ?? []),
  ]);
  // A purchased file streams as a sandboxed attachment: it keeps its own policy.
  return withPageCsp(url.pathname, response, {
    privateRelay: isBrowserContinuationRelayPathname(url.pathname),
    setPageCsp: (page) => setPageCspHeader(page, {
      origins: {
        apiBaseUrl: getRuntimeApiBaseUrl(),
        storefrontUrl: getRuntimeStorefrontUrl(),
        mediaUrl: getRuntimeMediaUrl(),
        cdnBaseUrl: getCdnBase(),
      },
      merchantSources: getRuntimeCspAllowedDomains(),
      // A buyer's own page is framed by nothing (the shells, the editor's canvas and a theme preview render excepted).
      frameAncestors: buyerPageForbidsFraming(url.pathname) && frameAncestors.length === 0 ? null : frameAncestors,
      // The same choice Layout.astro makes: the scripts of this page kind.
      appScriptOrigins: appScriptOrigins(appScriptsForPage(layout?.appScripts, storefrontAppPage(url.pathname))),
      // The browser hosts of the apps the theme draws (their islands).
      appConnectHosts: themeConnectHosts,
      inlineScriptHashes,
      storeScripts,
      paymentPage,
    }),
  });
});

// Seeds the request-scoped runtime: derived secrets from SCALIUS_SECRET, then
// public origins and merchant CSP sources from the layout payload (applied
// when that read resolves). Storefront pages start the layout read together
// with their own reads, so the whole render is one API batch; every other
// route waits for the origins first. Nothing is read from Wrangler vars or
// build-time env, and nothing is retained across requests. A buyer's own page
// asked for under a live theme preview never renders: the preview's notice
// answers in its place (`themePreviewBuyerPageNotice`).
const requestRuntimeMiddleware = defineMiddleware(({ request, url, routePattern, locals }, next) => {
  const early = redirectBeforeReads(request, url, routePattern);
  if (early) return early;
  return runWithRequestRuntime(request, getEnv(), async () => {
    const layout = getLayoutData();
    const previewNotice = await themePreviewBuyerPageNotice({ request, url }, layout);
    if (previewNotice) {
      (locals as PreviewFramingLocals).themePreviewRender = true;
      previewNotice.headers.set("X-Storefront-Build", BUILD_ID);
      return previewNotice;
    }
    const batchedPage =
      request.method === "GET" && isLayoutBatchedPagePath(url.pathname);
    if (!batchedPage) await layout;
    return next();
  });
});

/**
 * A catalog URL whose redirect the page decides from the URL alone answers
 * here, before the layout read starts, so it costs no API batch
 * (`catalogRedirectBeforeReads`), with the headers the response policy gives
 * any redirect. A presence render goes on to its page, so an inactive
 * presence still answers its 404.
 */
function redirectBeforeReads(request: Request, url: URL, routePattern: string): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (presenceOfRenderRequest(request)) return null;
  const redirect = catalogRedirectBeforeReads(routePattern, url);
  if (!redirect) return null;
  redirect.headers.set("X-Storefront-Build", BUILD_ID);
  setPrivateResponse(redirect, "BYPASS");
  return redirect;
}

const transportSecurityMiddleware = defineMiddleware(
  async ({ request, locals, url }, next) => {
    const redirect = redirectPlaintextRequest(request);
    if (redirect) return redirect;

    // The same path the page policy reads (Astro's `url.pathname`), so both framing answers agree.
    const pathname = url.pathname;
    const privateRelay = isBrowserContinuationRelayPathname(pathname);
    const response = await next();
    // The editor's relay and a preview render state their framing in CSP frame-ancestors.
    const framedByPolicy = isFramedBrowserContinuationRelayPathname(pathname)
      || (locals as PreviewFramingLocals).themePreviewRender === true;
    return applyTransportSecurityHeaders(request, response, {
      privateRelay,
      framedByPolicy,
      buyerPage: buyerPageForbidsFraming(pathname),
    });
  },
);

export const onRequest = sequence(
  transportSecurityMiddleware,
  requestRuntimeMiddleware,
  responsePolicyMiddleware,
);
