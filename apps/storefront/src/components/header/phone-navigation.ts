import { STOREFRONT_MOBILE_DEFAULT_TABS, type StorefrontMobileTabValue } from "@scalius/shared/storefront-theme";

export type PhoneTab = StorefrontMobileTabValue;

/** The theme's phone navigation (`blocks.mobileNav`), as every header draws it. */
export interface PhoneNavigation {
  /** The menu drawer: an accordion tree, or one level at a time. */
  menu: "accordion" | "drill";
  /** The store draws its bottom tab bar on phones. */
  tabBar: boolean;
  /** The tabs the theme chose (the bar falls back to its standard ones). */
  tabs?: readonly PhoneTab[];
  /** Compare has somewhere to start: the product page lists compare-similar. */
  compare: boolean;
}

/** One rule for CoreHeader and app header skins (their `phoneNavigation`, and the tab bar the store draws under them). */
export function phoneNavigation(blocks: {
  mobileNav: { variant: string; settings: unknown };
  product: { below: readonly string[] };
}): PhoneNavigation {
  const { variant } = blocks.mobileNav;
  const settings = (blocks.mobileNav.settings ?? {}) as { drawer?: unknown; tabs?: unknown };
  const tabBar = variant === "bottom-tabs";
  return {
    menu: variant === "drill-in-drawer" || (tabBar && settings.drawer === "drill-in") ? "drill" : "accordion",
    tabBar,
    ...(tabBar && Array.isArray(settings.tabs) ? { tabs: settings.tabs as PhoneTab[] } : {}),
    compare: blocks.product.below.includes("compare_similar"),
  };
}

/** What the bar shows: the chosen tabs that have a page here (Compare only where comparing is possible), topped up to three with the standard ones. */
export function shownPhoneTabs(tabs: readonly PhoneTab[] = STOREFRONT_MOBILE_DEFAULT_TABS, compare = false): PhoneTab[] {
  const chosen = tabs.filter((tab) => tab.kind !== "compare" || compare);
  if (chosen.length >= 3) return chosen;
  const missing = STOREFRONT_MOBILE_DEFAULT_TABS.filter((tab) => !chosen.some((each) => each.kind === tab.kind));
  return [...chosen, ...missing].slice(0, 3);
}

/** The header's phone icons the bar carries instead (`data-phone-drop`): the account and the cart. */
export function phoneDrops(tabs: readonly PhoneTab[] | null): string {
  if (!tabs) return "";
  return (["account", "cart"] as const).filter((kind) => tabs.some((tab) => tab.kind === kind)).join(" ");
}

/** Where the Offers tab leads. */
export const PHONE_OFFERS_HREF = "/search?hasDiscount=true";

/** The pages a tab leads to: the tab is current on each of them and on the pages under them. */
function phoneTabDestinations(tab: PhoneTab): readonly string[] {
  switch (tab.kind) {
    case "home": return ["/"];
    case "categories": return ["/categories", "/collections"];
    case "offers": return [PHONE_OFFERS_HREF];
    case "search": return ["/search"];
    case "compare": return ["/compare"];
    case "cart": return ["/cart"];
    case "account": return ["/account"];
    case "link": return [tab.href];
  }
}

/**
 * The tab is current on its own page and on pages under it (`/categories` and
 * `/categories/shoes`, `/blog` and `/blog/post`), for store destinations and
 * link tabs alike. Home is current only on `/`, every page being under it; a
 * destination with a query (Offers) needs that query, and Search yields to it.
 */
export function phoneTabCurrent(tab: PhoneTab, page: URL): boolean {
  const here = page.pathname.length > 1 ? page.pathname.replace(/\/+$/, "") : page.pathname;
  const offers = here === "/search" && page.searchParams.get("hasDiscount") === "true";
  if (tab.kind === "search" && offers) return false;
  return phoneTabDestinations(tab).some((href) => {
    let to: URL;
    try {
      to = new URL(href, page);
    } catch {
      return false;
    }
    if (to.origin !== page.origin) return false;
    for (const [key, value] of to.searchParams) if (page.searchParams.get(key) !== value) return false;
    const path = to.pathname.length > 1 ? to.pathname.replace(/\/+$/, "") : to.pathname;
    return path === "/" ? here === "/" : here === path || here.startsWith(`${path}/`);
  });
}
