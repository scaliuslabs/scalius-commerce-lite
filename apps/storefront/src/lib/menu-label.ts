// The store's own name for one of its pages, from its menus (Online store ->
// Navigation): the words a buyer already followed to get there, in the page's
// language (the layout read translates the menus). A page that no menu links
// keeps its catalogue name.
import { trimTrailingCharacter } from "@scalius/shared/text-scan";
import type { NavigationItem } from "@/lib/api";
import type { LayoutData } from "@/lib/api/storefront";

const NO_ORIGIN = "https://store.invalid";

/**
 * Whether `href` is exactly the page `path`: the same path (a trailing slash
 * aside), no query (`/blog?tag=linen` is one tag's listing, not the blog), on
 * this store (a relative link, or an absolute one to the store's own origin).
 */
function linksTo(href: string | undefined, path: string, storeOrigin: string): boolean {
  if (!href) return false;
  try {
    const url = new URL(href, storeOrigin);
    return url.origin === storeOrigin && url.search === "" && (trimTrailingCharacter(url.pathname, "/") || "/") === path;
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

function labelIn(items: readonly NavigationItem[] | undefined, path: string, storeOrigin: string): string | null {
  for (const item of levels(items)) {
    const title = item.title?.trim();
    if (title && linksTo(item.href, path, storeOrigin)) return title;
  }
  return null;
}

/**
 * The label of the header menu's link to exactly `path` (`/blog`), top-level
 * links first, else a footer menu's; null when no menu links it.
 */
export function menuLabelFor(
  layout: Pick<LayoutData, "navigation" | "footerMenus" | "platform"> | null | undefined,
  path: string,
): string | null {
  let storeOrigin = NO_ORIGIN;
  try {
    if (layout?.platform?.storefrontUrl) storeOrigin = new URL(layout.platform.storefrontUrl).origin;
  } catch {
    storeOrigin = NO_ORIGIN;
  }
  return labelIn(layout?.navigation, path, storeOrigin)
    ?? (layout?.footerMenus ?? []).map((menu) => labelIn(menu.links, path, storeOrigin)).find(Boolean)
    ?? null;
}
