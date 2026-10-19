import type { STOREFRONT_MOBILE_TABS } from "@scalius/shared/storefront-theme";

type Tab = (typeof STOREFRONT_MOBILE_TABS)[number];

/** The theme's phone navigation (`blocks.mobileNav`), as every header draws it. */
export interface PhoneNavigation {
  /** The menu drawer: an accordion tree, or one level at a time. */
  menu: "accordion" | "drill";
  /** The store draws its bottom tab bar on phones. */
  tabBar: boolean;
  /** The tabs the theme chose (the bar falls back to its standard ones). */
  tabs?: readonly Tab[];
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
    ...(tabBar && Array.isArray(settings.tabs) ? { tabs: settings.tabs as Tab[] } : {}),
    compare: blocks.product.below.includes("compare-similar"),
  };
}
