import type { NavigationItem } from "@/lib/api";

/**
 * Where the current page sits in the header menu: `page` when the item links
 * this page, `section` when one of its descendants does. Drives
 * `aria-current` (pills, sidebar, menus) and which sidebar/drawer levels
 * render expanded.
 */
export type NavigationCurrent = "page" | "section" | null;

/** The same-origin pathname a menu link points at, without a trailing slash. */
export function navigationPathname(href: string | undefined, page: URL): string | null {
  const value = href?.trim();
  if (!value || value.startsWith("#")) return null;
  let url: URL;
  try {
    url = new URL(value, page);
  } catch {
    return null;
  }
  if (url.origin !== page.origin) return null;
  return url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
}

export function navigationCurrent(item: NavigationItem, page: URL): NavigationCurrent {
  const here = page.pathname.length > 1 ? page.pathname.replace(/\/+$/, "") : page.pathname;
  if (navigationPathname(item.href, page) === here) return "page";
  return item.subMenu?.some((child) => navigationCurrent(child, page) !== null) ? "section" : null;
}

/** `aria-current` for a link: the page itself, or the section it is in. */
export function ariaCurrent(current: NavigationCurrent): "page" | "true" | undefined {
  return current === "page" ? "page" : current === "section" ? "true" : undefined;
}

export function navigationChildren(item: NavigationItem): NavigationItem[] {
  return Array.isArray(item.subMenu) ? item.subMenu.filter((child) => child?.title) : [];
}

/** Link attributes shared by every menu link. */
export function navigationLinkAttributes(item: NavigationItem) {
  return item.openInNewTab ? { target: "_blank", rel: "noopener noreferrer" } : {};
}
