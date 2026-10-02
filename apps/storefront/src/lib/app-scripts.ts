/**
 * Installed apps' storefront scripts (the layout payload's `appScripts`):
 * scripts of active apps whose hosts a Super Admin approved. Each loads on
 * the pages its app names, async from its https URL (never inline, never in
 * Partytown), and its origin joins that page's CSP `script-src` and
 * `connect-src`. Layout.astro and the middleware both decide from the same
 * two inputs (the layout payload and the URL path), so a page's CSP names
 * exactly the app scripts the page loads.
 */

/** The page kinds an app script can name (besides "all"). */
export const STOREFRONT_APP_PAGES = ["home", "product", "listing", "cart", "checkout", "order-success"] as const;
export type StorefrontAppPage = (typeof STOREFRONT_APP_PAGES)[number];

export interface StorefrontAppScript {
  pluginId: string;
  /** An https URL. */
  src: string;
  placement: "head" | "body-end";
  pages: Array<StorefrontAppPage | "all">;
}

/** Which kind of page a storefront path renders (null: a page only "all" scripts load on). */
export function storefrontAppPage(pathname: string): StorefrontAppPage | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return "home";
  if (/^\/products\/[^/]+$/.test(path)) return "product";
  if (/^\/(?:categories|brands|collections)\/[^/]+$/.test(path) || /^\/(?:categories|collections|search)$/.test(path)) {
    return "listing";
  }
  if (path === "/cart") return "cart";
  if (path === "/checkout" || path.startsWith("/checkout/")) return "checkout";
  if (path === "/order-success") return "order-success";
  return null;
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
export function appScriptsForPage(value: unknown, page: StorefrontAppPage | null): StorefrontAppScript[] {
  const seen = new Set<string>();
  return readAppScripts(value).filter((script) => {
    if (!script.pages.includes("all") && !(page && script.pages.includes(page))) return false;
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
