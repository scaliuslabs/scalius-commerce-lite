// src/lib/middleware-helper/csp-handler.ts
import {
  VIDEO_EMBED_FRAME_SOURCES,
  serializeCsp,
} from "@scalius/shared/http-security";
import {
  normalizePlatformOrigin,
  parseMerchantCspSources,
} from "@scalius/shared/security-csp";
import type { StoreScriptSources } from "@/lib/analytics-csp";

/**
 * Builds the page Content-Security-Policy.
 *
 * Scripts run only from the store's own origin, by the hash of each inline
 * script the storefront's code emits (lib/inline-script-policy.ts) or the
 * store saved (lib/analytics-csp.ts), and from the exact hosts those saved
 * scripts, the active apps and the payment provider name. Never
 * `'unsafe-inline'`, `'unsafe-eval'` or a wildcard host. Hashes rather than
 * nonces: a public page is cached with its headers and served to every
 * buyer, and every hash is known before the body renders, so a streamed or
 * cached page carries the policy that matches it.
 *
 * A payment page (checkout, payment recovery, a page that takes a card) gets
 * the tight variant: the storefront's own scripts and the payment provider's
 * documented script, frame and connect hosts; no store script, no app
 * script, no merchant-added source.
 *
 * Platform origins, merchant-managed additional sources (Settings ->
 * Security) and the hosts of approved app scripts all arrive in the
 * request's layout payload, so building the header costs no extra read.
 *
 * Hosted payment pages (SSLCommerz, bKash, Nagad: app providers) need no
 * source here: checkout sends the buyer there with a top-level navigation,
 * which CSP does not govern, and nothing on the storefront loads, frames or
 * posts a form to them. Their hosts are each app's `allowedHosts`, for its
 * own server-side calls.
 */

/** Platform origins that are always allowed, resolved per request. */
export interface CspPlatformOrigins {
  /** Public API origin (no /api/v1), e.g. https://api.example.com */
  apiBaseUrl?: string;
  /** Absolute storefront origin. */
  storefrontUrl?: string;
  /** Platform media base URL. */
  mediaUrl?: string;
  /** Effective image CDN base (dashboard media setting or platform media host). */
  cdnBaseUrl?: string;
}

/**
 * The card payment providers' sources, per directive, as Stripe documents
 * them for Stripe.js (docs.stripe.com/security/guide, "Content Security
 * Policy"): its script and frames on js.stripe.com and its subdomains, the
 * 3-D Secure and redirect frame on hooks.stripe.com, its API. The one list
 * of every page that takes a card: the payment pages' policy and the
 * continuations' strict policy (`cardPageCsp`).
 */
export const PAYMENT_PROVIDER_CSP_SOURCES = {
  script: ["https://js.stripe.com", "https://*.js.stripe.com"],
  frame: ["https://js.stripe.com", "https://*.js.stripe.com", "https://hooks.stripe.com"],
  connect: ["https://api.stripe.com"],
} as const satisfies Record<"script" | "frame" | "connect", readonly string[]>;

/**
 * A card page's strict policy (the agent and checkout continuations): its
 * own files, the payment providers' sources exactly as every payment page
 * allows them, no inline script but the one named by its hash (the colour
 * scheme's), no framing, no other origin.
 */
export function cardPageCsp(scriptSource: string | null): string {
  const payment = (directive: keyof typeof PAYMENT_PROVIDER_CSP_SOURCES) => PAYMENT_PROVIDER_CSP_SOURCES[directive].join(" ");
  return [
    "default-src 'self'",
    `script-src 'self'${scriptSource ? ` ${scriptSource}` : ""} ${payment("script")}`,
    `connect-src 'self' ${payment("connect")}`,
    `frame-src ${payment("frame")}`,
    "object-src 'none'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
}

/**
 * The platform-owned origins (media, CDN, API, storefront), https or a
 * loopback origin in local development; malformed values are dropped rather
 * than widened.
 */
function platformOrigins(origins: CspPlatformOrigins): string[] {
  return [...new Set([origins.cdnBaseUrl, origins.mediaUrl, origins.apiBaseUrl, origins.storefrontUrl].flatMap((raw) => {
    const origin = raw?.trim() ? normalizePlatformOrigin(raw.trim()) : null;
    return origin ? [origin] : [];
  }))];
}

/**
 * The origins of the app scripts this page loads (lib/app-scripts.ts): https
 * only, exact origins, never a wildcard. Anything else is dropped.
 */
function appScriptDomains(appScriptOrigins: readonly string[]): string[] {
  return [...new Set(appScriptOrigins.flatMap((value) => {
    const candidate = value.trim();
    if (!candidate.toLowerCase().startsWith("https://")) return [];
    const origin = normalizePlatformOrigin(candidate);
    return origin ? [origin] : [];
  }))];
}

/** App connect hosts as CSP sources: `https://host` or `https://*.host`, a manifest host pattern only. */
function appConnectSources(hosts: readonly string[]): string[] {
  return [...new Set(hosts.flatMap((host) => (
    /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?$/.test(host) ? [`https://${host}`] : []
  )))];
}

export interface PageCspInput {
  origins?: CspPlatformOrigins;
  /** Merchant-managed additional sources (Settings → Security), comma or line separated. */
  merchantSources?: string;
  /**
   * Origins besides the storefront that may frame the page (the dashboard, under a theme preview only);
   * `null` for a buyer's own page, which nothing frames, the storefront included.
   */
  frameAncestors?: readonly string[] | null;
  /** Origins of the active apps' scripts this page loads (the layout payload's `appScripts` for this page kind). */
  appScriptOrigins?: readonly string[];
  /** Hosts the theme's apps' islands reach from the browser (approved with the app): connect and images only. */
  appConnectHosts?: readonly string[];
  /** The hashes of the storefront's own inline scripts (`storefrontInlineScriptHashes`). */
  inlineScriptHashes?: readonly string[];
  /** What the store's saved scripts need (`storeScriptSources`); none on a payment page. */
  storeScripts?: StoreScriptSources | null;
  /** A payment page: the tight variant. */
  paymentPage?: boolean;
}

/** The page policy for one response. */
export function pageContentSecurityPolicy(input: PageCspInput = {}): string {
  const origins = input.origins ?? {};
  const platform = platformOrigins(origins);
  const apiOrigin = normalizePlatformOrigin(origins.apiBaseUrl?.trim() ?? "");
  const hashes = input.inlineScriptHashes ?? [];
  const frameAncestors = input.frameAncestors === undefined ? [] : input.frameAncestors;
  const ancestors = frameAncestors === null ? ["'none'"] : ["'self'", ...frameAncestors];
  const common = (name: string, sources: readonly string[]) => [name, sources] as const;

  if (input.paymentPage) {
    return serializeCsp([
      common("default-src", ["'self'"]),
      common("script-src", ["'self'", ...hashes, ...PAYMENT_PROVIDER_CSP_SOURCES.script]),
      common("style-src", ["'self'", "'unsafe-inline'"]),
      common("img-src", ["'self'", "data:", "blob:", "https:", ...platform]),
      common("font-src", ["'self'", "data:"]),
      common("connect-src", ["'self'", ...(apiOrigin ? [apiOrigin] : []), ...platform, ...PAYMENT_PROVIDER_CSP_SOURCES.connect]),
      common("frame-src", ["'self'", ...PAYMENT_PROVIDER_CSP_SOURCES.frame]),
      common("worker-src", ["'self'"]),
      common("manifest-src", ["'self'"]),
      common("object-src", ["'none'"]),
      common("base-uri", ["'self'"]),
      common("form-action", ["'self'"]),
      common("frame-ancestors", ancestors),
    ]);
  }

  const merchant = input.merchantSources ? parseMerchantCspSources(input.merchantSources) : [];
  const store = input.storeScripts ?? { scriptHashes: [], script: [], connect: [], img: [], frame: [] };
  const apps = appScriptDomains(input.appScriptOrigins ?? []);
  const appConnect = appConnectSources(input.appConnectHosts ?? []);
  return serializeCsp([
    common("default-src", ["'self'"]),
    common("script-src", ["'self'", ...hashes, ...store.scriptHashes, ...store.script, ...apps, ...merchant]),
    common("style-src", ["'self'", "'unsafe-inline'", ...merchant]),
    common("img-src", ["'self'", "data:", "blob:", "https:", ...platform, ...store.img, ...appConnect, ...merchant]),
    common("font-src", ["'self'", "data:", ...merchant]),
    common("media-src", ["'self'", "blob:", ...platform, ...merchant]),
    common("connect-src", ["'self'", ...(apiOrigin ? [apiOrigin] : []), ...platform, ...store.connect, ...apps, ...appConnect, ...merchant]),
    common("frame-src", ["'self'", ...VIDEO_EMBED_FRAME_SOURCES, ...store.frame, ...merchant]),
    common("worker-src", ["'self'", "blob:", ...merchant]),
    common("manifest-src", ["'self'"]),
    common("object-src", ["'none'"]),
    common("base-uri", ["'self'"]),
    common("form-action", ["'self'"]),
    common("frame-ancestors", ancestors),
  ]);
}

/** Sets the page policy on a response. */
export function setPageCspHeader(response: Response, input: PageCspInput = {}): Response {
  response.headers.set("Content-Security-Policy", pageContentSecurityPolicy(input));
  return response;
}
