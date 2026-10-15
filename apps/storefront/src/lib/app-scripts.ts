/**
 * Installed apps' storefront scripts (the layout payload's `appScripts`):
 * scripts of active apps whose hosts a Super Admin approved. Each loads on
 * the pages its app names, async from its https URL (never inline, never in
 * Partytown), and its origin joins that page's CSP `script-src` and
 * `connect-src`. Layout.astro and the middleware both decide from the same
 * two inputs (the layout payload and the URL path), so a page's CSP names
 * exactly the app scripts the page loads.
 *
 * "all" means every page except the buyer's pages (cart, checkout, the receipt and
 * every private page: account, payment recovery, order tracking, …). An
 * app's JavaScript never runs on those pages and a manifest cannot name them.
 */

import { isUncachedPrivateStorefrontPathname } from "./cache-policy";

/** The page kinds an app script can name (besides "all"). */
export const STOREFRONT_APP_PAGES = ["home", "product", "listing"] as const;
export type StorefrontAppPage = (typeof STOREFRONT_APP_PAGES)[number];

export interface StorefrontAppScript {
  pluginId: string;
  /** An https URL. */
  src: string;
  placement: "head" | "body-end";
  pages: Array<StorefrontAppPage | "all">;
}

/** Which kind of page a storefront path renders ("private": a buyer's page, no app code; null: a page only "all" scripts load on). */
export function storefrontAppPage(pathname: string): StorefrontAppPage | "private" | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return "home";
  if (/^\/products\/[^/]+$/.test(path)) return "product";
  if (/^\/(?:categories|brands|collections)\/[^/]+$/.test(path) || /^\/(?:categories|collections|search)$/.test(path)) {
    return "listing";
  }
  // Cart, checkout, the receipt and the other buyer pages; the theme editor's canvas is the merchant's.
  if (path === "/cart" || path.startsWith("/cart/") || path === "/checkout" || path.startsWith("/checkout/") || path === "/order-success") return "private";
  return isUncachedPrivateStorefrontPathname(path) && !/^\/theme-preview(?:\/|$)/.test(path) ? "private" : null;
}

/** App components (theme slots, sections and their islands) cannot name a page, so none renders on a buyer's page: the core chrome does. */
export function appComponentsRenderOn(page: StorefrontAppPage | "private" | null): boolean {
  return page !== "private";
}

const PAGE_NAMES = new Set<string>([...STOREFRONT_APP_PAGES, "all"]);

function httpsScriptUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && url.hostname ? url.href : null;
  } catch {
    return null;
  }
}

/** The layout payload's app scripts, shape-checked (https only); anything malformed is left out. */
export function readAppScripts(value: unknown): StorefrontAppScript[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { pluginId, src, placement, pages } = entry as Record<string, unknown>;
    const url = httpsScriptUrl(src);
    if (typeof pluginId !== "string" || !pluginId || !url) return [];
    if (placement !== "head" && placement !== "body-end") return [];
    if (!Array.isArray(pages)) return [];
    const named = pages.filter((page): page is StorefrontAppPage | "all" => typeof page === "string" && PAGE_NAMES.has(page));
    return named.length > 0 ? [{ pluginId, src: url, placement, pages: named }] : [];
  });
}

/** The scripts a page of this kind loads: those naming it or "all", each URL once. */
export function appScriptsForPage(value: unknown, page: StorefrontAppPage | "private" | null): StorefrontAppScript[] {
  const seen = new Set<string>();
  const allApplies = page !== "private";
  return readAppScripts(value).filter((script) => {
    const named = page !== null && page !== "private" && script.pages.includes(page);
    if (!named && !(allApplies && script.pages.includes("all"))) return false;
    if (seen.has(script.src)) return false;
    seen.add(script.src);
    return true;
  });
}

/** The https origins of these scripts, each once (what the page CSP adds). */
export function appScriptOrigins(scripts: readonly StorefrontAppScript[]): string[] {
  const origins = new Set<string>();
  for (const script of scripts) {
    const url = httpsScriptUrl(script.src);
    if (url) origins.add(new URL(url).origin);
  }
  return [...origins];
}
