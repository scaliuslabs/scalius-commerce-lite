// The store's own name for one of its pages, from its menus (Online store ->
// Navigation): the words a buyer already followed to get there, in the page's
// language (the layout read translates the menus). A page that no menu links
// keeps its catalogue name.
import { trimTrailingCharacter } from "@scalius/shared/text-scan";
import type { NavigationItem } from "@/lib/api";
import type { LayoutData } from "@/lib/api/storefront";

const ORIGIN = "https://store.invalid";

function linksTo(href: string | undefined, path: string): boolean {
  if (!href) return false;
  try {
    const url = new URL(href, ORIGIN);
    return url.origin === ORIGIN && (trimTrailingCharacter(url.pathname, "/") || "/") === path;
  } catch {
    return false;
  }
}

function findLabel(items: readonly NavigationItem[] | undefined, path: string): string | null {
  for (const item of items ?? []) {
    const title = item.title?.trim();
    if (title && linksTo(item.href, path)) return title;
    const nested = findLabel(item.subMenu, path);
    if (nested) return nested;
  }
  return null;
}

/**
 * The label of the first header menu link to `path` (`/blog`), else of the
 * first footer menu link to it; null when no menu links it.
 */
export function menuLabelFor(layout: Pick<LayoutData, "navigation" | "footerMenus"> | null | undefined, path: string): string | null {
  return findLabel(layout?.navigation, path)
    ?? (layout?.footerMenus ?? []).map((menu) => findLabel(menu.links, path)).find(Boolean)
    ?? null;
}
