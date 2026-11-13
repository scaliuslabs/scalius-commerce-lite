/**
 * The store's own scripts (Settings → Analytics: GA4, Meta, TikTok,
 * Cloudflare, custom snippets) in the page's Content-Security-Policy.
 *
 * Each inline script of a saved snippet is allowed by its SHA-256 hash, so
 * the scripts the merchant saved run and a script injected into the page does
 * not. The hosts a snippet loads scripts from are the https origins its own
 * `src` attributes name; the hosts a known tag reports to (its beacons and
 * collection endpoints, which no snippet names) come from the vendor's
 * documented list below, only when the store uses that vendor. No wildcard
 * ever reaches `script-src`.
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
import { cspHashSource, htmlScriptBlocks, isRunnableScriptType } from "@scalius/shared/http-security";

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
}

interface VendorHosts {
  script: readonly string[];
  connect: readonly string[];
  img: readonly string[];
}

/**
 * The hosts each known tag reaches from the page, as each vendor documents
 * them for a Content-Security-Policy (Google: developers.google.com/tag-platform/security/guides/csp;
 * Meta: the Pixel's fbevents.js and its /tr beacon; TikTok: analytics.tiktok.com;
 * Cloudflare Web Analytics: its beacon script and RUM endpoint).
 */
const VENDORS: ReadonlyArray<{ matches: (script: Pick<AnalyticsConfig, "type" | "config">) => boolean; hosts: VendorHosts }> = [
  {
    matches: (script) => ["google_analytics", "google_tag_manager"].includes(script.type) || /googletagmanager\.com|\bgtag\s*\(/i.test(script.config),
    hosts: {
      script: ["https://www.googletagmanager.com"],
      connect: ["https://*.google-analytics.com", "https://*.analytics.google.com", "https://*.googletagmanager.com"],
      img: ["https://*.google-analytics.com", "https://*.googletagmanager.com"],
    },
  },
  {
    matches: (script) => script.type === "facebook_pixel" || /connect\.facebook\.net|\bfbq\s*\(/i.test(script.config),
    hosts: {
      script: ["https://connect.facebook.net"],
      connect: ["https://www.facebook.com", "https://connect.facebook.net"],
      img: ["https://www.facebook.com"],
    },
  },
  {
    matches: (script) => script.type === "tiktok_pixel" || /analytics\.tiktok\.com|\bttq\./i.test(script.config),
    hosts: {
      script: ["https://analytics.tiktok.com"],
      connect: ["https://analytics.tiktok.com"],
      img: ["https://analytics.tiktok.com"],
    },
  },
  {
    matches: (script) => script.type === "cloudflare_web_analytics" || /static\.cloudflareinsights\.com/i.test(script.config),
    hosts: {
      script: ["https://static.cloudflareinsights.com"],
      connect: ["https://cloudflareinsights.com"],
      img: [],
    },
  },
];

const URL_ATTRIBUTE = /<(img|iframe)\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

/** The https origin of a URL a snippet names, or null (never http, never a path). */
function httpsOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}

/** A script's real type: a consent-gated one keeps it in `data-scalius-type`. */
function scriptType(attributes: ReadonlyMap<string, string>): string | undefined {
  return attributes.get("data-scalius-type") ?? attributes.get("type");
}

/**
 * The sources the given saved scripts need: each inline script's hash (a
 * Partytown or data block runs nowhere on the page and needs none), the
 * origins their own `src`, image and frame attributes name, and their
 * vendors' documented hosts.
 */
export async function storeScriptSources(scripts: readonly Pick<AnalyticsConfig, "type" | "config">[]): Promise<StoreScriptSources> {
  const bodies: string[] = [];
  const sources: Omit<StoreScriptSources, "scriptHashes"> = { script: [], connect: [], img: [], frame: [] };
  for (const script of scripts) {
    for (const block of htmlScriptBlocks(script.config)) {
      if (!isRunnableScriptType(scriptType(block.attributes))) continue;
      const src = block.attributes.get("src");
      if (src === undefined) {
        bodies.push(block.body);
        continue;
      }
      const origin = httpsOrigin(src);
      if (origin) {
        sources.script.push(origin);
        sources.connect.push(origin);
      }
    }
    for (const match of script.config.matchAll(URL_ATTRIBUTE)) {
      const origin = httpsOrigin(match[2] ?? match[3] ?? match[4]);
      if (origin) (match[1]!.toLowerCase() === "img" ? sources.img : sources.frame).push(origin);
    }
    for (const vendor of VENDORS) {
      if (!vendor.matches(script)) continue;
      sources.script.push(...vendor.hosts.script);
      sources.connect.push(...vendor.hosts.connect);
      sources.img.push(...vendor.hosts.img);
    }
  }
  const unique = (values: string[]) => [...new Set(values)];
  return {
    scriptHashes: unique(await Promise.all(bodies.map(cspHashSource))),
    script: unique(sources.script),
    connect: unique(sources.connect),
    img: unique(sources.img),
    frame: unique(sources.frame),
  };
}
