/**
 * The store's own scripts (Settings → Analytics: GA4, Meta, TikTok,
 * Cloudflare, custom snippets) in the page's Content-Security-Policy.
 *
 * Each inline script of a saved snippet is allowed by its SHA-256 hash, so
 * the scripts the merchant saved run and a script injected into the page does
 * not. The hosts a snippet loads scripts from are the plain https origins
 * its own `src` attributes name (`@scalius/shared/store-scripts`: no
 * wildcard, comma, semicolon or quote can reach the header, and the store's
 * snippets together stay within fixed limits; the API refuses a snippet past
 * them). The hosts a known tag reports to (its beacons and collection
 * endpoints, which no snippet names) come from the vendor's documented list
 * below, only when the store uses that tag. No wildcard reaches `script-src`.
 *
 * What does not run: an inline event handler (`onclick=`), `eval`, and an
 * inline script that a tag writes at run time (a Tag Manager "Custom HTML"
 * tag): none of them is a saved script. A tag manager's built-in tags load
 * as files from its own host and keep working.
 *
 * A payment page (checkout, payment recovery, a page that takes a card) runs
 * none of the store's scripts: only the payment provider's.
 */
import type { AnalyticsConfig } from "@/lib/api";
import { cspHashSource } from "@scalius/shared/http-security";
import { boundStoreScripts, snippetSources, storeTagIds } from "@scalius/shared/store-scripts";

interface PaymentPageLocals {
  /** Set by a payment page's own frontmatter, before its headers leave. */
  scaliusPaymentPage?: boolean;
}

/**
 * Marks the page being rendered as a payment page. Call it from the page's
 * own frontmatter: a streamed page's headers leave before its layout renders.
 */
export function markPaymentPage(locals: object): void {
  (locals as PaymentPageLocals).scaliusPaymentPage = true;
}

/** Whether the page marked itself a payment page. */
export function isPaymentPage(locals: object): boolean {
  return (locals as PaymentPageLocals).scaliusPaymentPage === true;
}

/** Whether the store's own scripts render on this page (never on a payment page). */
export function rendersStoreScripts(locals: object): boolean {
  return !isPaymentPage(locals);
}

/** The policy sources the store's saved scripts need. */
export interface StoreScriptSources {
  /** `'sha256-…'` of each inline script the snippets hold. */
  scriptHashes: string[];
  script: string[];
  connect: string[];
  img: string[];
  frame: string[];
  /** Snippets dropped whole for breaking the store's limits (their scripts do not run). */
  dropped: number;
}

type Snippet = Pick<AnalyticsConfig, "type" | "config">;

interface VendorHosts {
  script?: readonly string[];
  connect?: readonly string[];
  img?: readonly string[];
  frame?: readonly string[];
}

/*
 * Google's CSP guide (developers.google.com/tag-platform/security/guides/csp,
 * read 2026-11-13): GA4 "with Google Ads features" (Signals) and Google Ads
 * conversions and remarketing. Country domains (`*.google.<TLD>`) are not
 * listed one by one: `*.google.com` covers the endpoints the tags use first.
 * `td.doubleclick.net` is the remarketing frame the Ads tag opens.
 */
const GOOGLE_TAG: VendorHosts = {
  script: ["https://www.googletagmanager.com"],
  img: ["https://www.googletagmanager.com", "https://*.google-analytics.com", "https://*.google.com", "https://*.g.doubleclick.net"],
  connect: ["https://www.googletagmanager.com", "https://*.google-analytics.com", "https://*.analytics.google.com", "https://*.google.com", "https://*.g.doubleclick.net", "https://pagead2.googlesyndication.com"],
  frame: ["https://www.googletagmanager.com"],
};
const GOOGLE_ADS: VendorHosts = {
  script: ["https://www.googleadservices.com", "https://www.google.com"],
  img: ["https://www.googleadservices.com", "https://googleads.g.doubleclick.net", "https://pagead2.googlesyndication.com", "https://www.google.com"],
  connect: ["https://www.googleadservices.com", "https://googleads.g.doubleclick.net", "https://pagead2.googlesyndication.com", "https://www.google.com", "https://ad.doubleclick.net"],
  frame: ["https://td.doubleclick.net"],
};
/* Meta's pixel guide: scripts from connect.facebook.net; its /tr beacon on www.facebook.com. */
const META_PIXEL: VendorHosts = {
  script: ["https://connect.facebook.net"],
  connect: ["https://www.facebook.com", "https://connect.facebook.net"],
  img: ["https://www.facebook.com"],
};
/* TikTok publishes no CSP list: its pixel loads and reports on analytics.tiktok.com. */
const TIKTOK_PIXEL: VendorHosts = {
  script: ["https://analytics.tiktok.com"],
  connect: ["https://analytics.tiktok.com"],
  img: ["https://analytics.tiktok.com"],
};
/* Cloudflare Web Analytics: its beacon script and RUM endpoint. */
const CLOUDFLARE: VendorHosts = {
  script: ["https://static.cloudflareinsights.com"],
  connect: ["https://cloudflareinsights.com"],
};

/** The documented hosts of the tags a snippet runs. */
function vendorHosts(snippet: Snippet): VendorHosts[] {
  const ids = storeTagIds([snippet]);
  const google = ["google_analytics", "google_tag_manager"].includes(snippet.type)
    || ids.containers.size > 0 || ids.googleTags.size > 0 || /googletagmanager\.com|\bgtag\s*\(/i.test(snippet.config);
  // Google Ads: an AW- tag, or a container (it may hold one).
  const ads = ids.containers.size > 0 || [...ids.googleTags].some((tag) => tag.startsWith("AW-")) || snippet.type === "google_tag_manager";
  return [
    ...(google ? [GOOGLE_TAG] : []),
    ...(ads ? [GOOGLE_ADS] : []),
    ...(snippet.type === "facebook_pixel" || /connect\.facebook\.net|\bfbq\s*\(/i.test(snippet.config) ? [META_PIXEL] : []),
    ...(snippet.type === "tiktok_pixel" || /analytics\.tiktok\.com|\bttq\./i.test(snippet.config) ? [TIKTOK_PIXEL] : []),
    ...(snippet.type === "cloudflare_web_analytics" || /static\.cloudflareinsights\.com/i.test(snippet.config) ? [CLOUDFLARE] : []),
  ];
}

/**
 * The sources the given saved scripts need: each runnable inline script's
 * hash, the plain https origins their own script, image and frame addresses
 * name, and their tags' documented hosts. A snippet past the store's limits
 * is dropped whole (logged: the API refuses to save one).
 */
export async function storeScriptSources(scripts: readonly Snippet[]): Promise<StoreScriptSources> {
  const bounded = boundStoreScripts(scripts.map((script) => snippetSources(script.config)));
  if (bounded.dropped.length > 0) {
    console.warn(`[csp] ${bounded.dropped.length} store script(s) past the limits do not run`);
  }
  const keptSnippets = scripts.filter((_, index) => !bounded.dropped.includes(index));
  const unique = (values: string[]) => [...new Set(values)];
  const vendors = keptSnippets.flatMap(vendorHosts);
  return {
    scriptHashes: unique(await Promise.all(bounded.kept.flatMap((sources) => sources.inline).map(cspHashSource))),
    script: unique([...bounded.kept.flatMap((sources) => sources.script), ...vendors.flatMap((hosts) => hosts.script ?? [])]),
    connect: unique([...bounded.kept.flatMap((sources) => sources.script), ...vendors.flatMap((hosts) => hosts.connect ?? [])]),
    img: unique([...bounded.kept.flatMap((sources) => sources.img), ...vendors.flatMap((hosts) => hosts.img ?? [])]),
    frame: unique([...bounded.kept.flatMap((sources) => sources.frame), ...vendors.flatMap((hosts) => hosts.frame ?? [])]),
    dropped: bounded.dropped.length,
  };
}
