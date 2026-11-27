// The store's own name for one of its pages, from its menus (Online store ->
// Navigation): the words a buyer already followed to get there, in the page's
// language (the layout read translates the menus). A page that no menu links
// keeps its catalogue name.
import { trimTrailingCharacter } from "@scalius/shared/text-scan";
import type { NavigationItem } from "@/lib/api";
import type { LayoutData } from "@/lib/api/storefront";

import { getAbsoluteStorefrontSeoBaseUrl } from "@/lib/seo-base-url";

/** The base a relative link resolves on: never a store's host. */
const RELATIVE_BASE = "https://relative.invalid";

/** A host as the store's own: its name without a leading `www.`, and its port. */
function storeHost(url: URL): string {
  return `${url.hostname.replace(/^www\./, "")}:${url.port}`;
}

/**
 * Whether `href` is exactly the page `path`: the same path (a trailing slash
 * aside), no query (`/blog?tag=linen` is one tag's listing, not the blog), on
 * this store (a relative link, or an absolute one to one of `storeHosts`).
 */
function linksTo(href: string | undefined, path: string, storeHosts: ReadonlySet<string>): boolean {
  if (!href) return false;
  try {
    const url = new URL(href, RELATIVE_BASE);
    const own = url.origin === RELATIVE_BASE || ((url.protocol === "https:" || url.protocol === "http:") && storeHosts.has(storeHost(url)));
    return own && url.search === "" && (trimTrailingCharacter(url.pathname, "/") || "/") === path;
  } catch {
    return false;
  }
}

/** A menu's links level by level: every top-level link before any nested one. */
function* levels(items: readonly NavigationItem[] | undefined): Generator<NavigationItem> {
  let level: readonly NavigationItem[] = items ?? [];
  while (level.length > 0) {
    yield* level;
    level = level.flatMap((item) => item.subMenu ?? []);
  }
}

function labelIn(items: readonly NavigationItem[] | undefined, path: string, storeHosts: ReadonlySet<string>): string | null {
  for (const item of levels(items)) {
    const title = item.title?.trim();
    if (title && linksTo(item.href, path, storeHosts)) return title;
  }
  return null;
}

/**
 * The label of the header menu's link to exactly `path` (`/blog`), top-level
 * links first, else a footer menu's; null when no menu links it. An absolute
 * link is the store's own when it names the store's address (the request's
 * Store URL, or the layout's), with or without `www.`.
 */
export function menuLabelFor(
  layout: Pick<LayoutData, "navigation" | "footerMenus" | "platform"> | null | undefined,
  path: string,
): string | null {
  const storeHosts = new Set<string>();
  for (const address of [getAbsoluteStorefrontSeoBaseUrl(), layout?.platform?.storefrontUrl]) {
    try {
      if (address) storeHosts.add(storeHost(new URL(address)));
    } catch {
      // Not an address: no absolute link matches it.
    }
  }
  return labelIn(layout?.navigation, path, storeHosts)
    ?? (layout?.footerMenus ?? []).map((menu) => labelIn(menu.links, path, storeHosts)).find(Boolean)
    ?? null;
}
