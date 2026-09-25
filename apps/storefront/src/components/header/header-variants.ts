/**
 * The header variants as data (theme block `header`). Every variant except
 * `mall-departments` renders through ComposedHeader.astro from this spec;
 * `mall-departments` is today's classic header (ClassicHeader.astro), kept
 * pixel-identical because the default template uses it. Sizes are the
 * measured desktop anatomy (SYNTHESIS.md section 2.2); colours, radius and
 * type come from the theme tokens, never from here.
 *
 * Phones share one grammar whatever the variant: a 56px bar (menu, logo
 * centred, account, cart) that condenses to 48px on scroll, plus an
 * optional search row that folds away on scroll, so the sticky stack stays
 * under 120px (mix rule 6).
 */
import type { StorefrontBlockVariant } from "@scalius/shared/storefront-theme";

export type HeaderVariant = StorefrontBlockVariant<"header">;

export interface HeaderSpec {
  /** The main row wears the header tone (`headerTone`: dark or brand headers). */
  toneRow: boolean;
  /** The menu row under it: the header tone, or the page surface. */
  menuRowTone: "tone" | "surface";
  /** Where the desktop menu sits: in the main row, or its own row below. */
  menu: "inline" | "row";
  /** Top-level menu items in capitals (fashion departments). */
  uppercaseMenu: boolean;
  /** icon: a 44px button; field: a filled field; pill: a rounded field; scoped: department select + field + button. */
  search: "icon" | "field" | "pill" | "scoped";
  /** How account, track order and cart read on computers. */
  utilities: "icons" | "stacked" | "two-line" | "round";
  /** A running cart total beside the cart (unless the settings turn it off). */
  cartTotal: boolean;
  /** Phones: a full-width search row under the bar. */
  phoneSearch: "none" | "sticky" | "in-page";
  /** Phones: a scrolling row of top links under the header (not sticky). */
  phoneShortcuts: boolean;
  /** Desktop heights in rem: the main row and the menu row. */
  mainHeight: number;
  menuHeight: number;
}

export const HEADER_SPECS: Record<Exclude<HeaderVariant, "mall-departments">, HeaderSpec> = {
  // Dawn: 84px, logo, 3-6 inline items, 44px icon buttons (search expands).
  "boutique-inline": {
    toneRow: false,
    menuRowTone: "surface",
    menu: "inline",
    uppercaseMenu: false,
    search: "icon",
    utilities: "icons",
    cartTotal: false,
    phoneSearch: "none",
    phoneShortcuts: false,
    mainHeight: 5.25,
    menuHeight: 0,
  },
  // Fabrilife: 80px, uppercase departments, a filled 300x44 search,
  // icon-over-label utilities.
  "fashion-department": {
    toneRow: false,
    menuRowTone: "surface",
    menu: "inline",
    uppercaseMenu: true,
    search: "field",
    utilities: "stacked",
    cartTotal: false,
    phoneSearch: "none",
    phoneShortcuts: false,
    mainHeight: 5,
    menuHeight: 0,
  },
  // Star Tech: an 82px toned row (580px search, two-line utilities), then a
  // 50px light category row that stays on its own; phones keep the search in
  // the page under a 50px bar.
  "spec-two-row": {
    toneRow: true,
    menuRowTone: "surface",
    menu: "row",
    uppercaseMenu: false,
    search: "field",
    utilities: "two-line",
    cartTotal: false,
    phoneSearch: "in-page",
    phoneShortcuts: false,
    mainHeight: 5.125,
    menuHeight: 3.125,
  },
  // Apple Gadgets: an 80px toned row with a 584x48 pill search and 48px
  // round icons, then a 52px light row of centred categories.
  "tech-rounded": {
    toneRow: true,
    menuRowTone: "surface",
    menu: "row",
    uppercaseMenu: false,
    search: "pill",
    utilities: "round",
    cartTotal: false,
    phoneSearch: "sticky",
    phoneShortcuts: false,
    mainHeight: 5,
    menuHeight: 3.25,
  },
  // Amazon, Daraz: a 60px toned row with a department-scoped search (790x40)
  // and two-line utilities, then a 40px toned row ("All" plus top links).
  "marketplace-search": {
    toneRow: true,
    menuRowTone: "tone",
    menu: "row",
    uppercaseMenu: false,
    search: "scoped",
    utilities: "two-line",
    cartTotal: false,
    phoneSearch: "sticky",
    phoneShortcuts: true,
    mainHeight: 3.75,
    menuHeight: 2.5,
  },
  // Target, Walmart: an 80px row with the menu as pills, a 628x44 pill
  // search, account and cart (optionally with its total).
  "retail-pill": {
    toneRow: true,
    menuRowTone: "surface",
    menu: "inline",
    uppercaseMenu: false,
    search: "pill",
    utilities: "two-line",
    cartTotal: false,
    phoneSearch: "sticky",
    phoneShortcuts: true,
    mainHeight: 5,
    menuHeight: 0,
  },
  // Chaldal: a 72px light shell header with a wide 48px search and the cart
  // total always in view; the departments column sits beside the page.
  "grocery-shell": {
    toneRow: false,
    menuRowTone: "surface",
    menu: "row",
    uppercaseMenu: false,
    search: "field",
    utilities: "icons",
    cartTotal: true,
    phoneSearch: "sticky",
    phoneShortcuts: false,
    mainHeight: 4.5,
    menuHeight: 2.75,
  },
};

/**
 * What changes height when the page scrolls. The sticky header condenses (a
 * shorter bar; the phone search row and the classic dropdown row fold
 * away), and the page under it must not move: while condensed the header
 * keeps its expanded height in the flow as a bottom margin (CLS 0). The rows
 * paint with these lengths and the reserve is built from the same custom
 * properties, so the two can never drift apart; rows and reserve animate
 * with one shared transition, so their sum is the same in every frame.
 */
export const HEADER_GEOMETRY = {
  /** The one transition every condensing height and the reserve use. */
  condense: { duration: "300ms", easing: "cubic-bezier(0.25, 0.1, 0.25, 1)" },
  /** Every phone bar: 56px, 48px once scrolled. */
  phoneBar: { expanded: "3.5rem", condensed: "3rem" },
  /** A header search field (HeaderSearch), and the space under the phone search row. */
  searchField: "2.75rem",
  phoneSearchGap: "0.5rem",
  /** The classic header's main row on computers: 72px, 64px once scrolled. */
  classicBar: { expanded: "4.5rem", condensed: "4rem" },
  /**
   * The classic header's dropdown row, which folds into the bar on scroll:
   * its top border, 0.5rem above and below the menu, and a menu link's
   * height (DesktopNav; touch screens keep 44px targets).
   */
  classicMenuRow: { border: "1px", padding: "0.5rem", link: { fine: "2.5rem", coarse: "2.75rem" } },
} as const;

export interface HeaderCondense {
  /** The height the header loses on scroll below 64rem, as a CSS length. */
  phone: string;
  /** ...and from 64rem. */
  desktop: string;
}

/**
 * How much a header condenses on scroll: the reserve that keeps the page
 * still. `spec` null is the classic header; `foldsMenuRow` its dropdown row
 * folding into the bar.
 */
export function headerCondense(spec: HeaderSpec | null, options: { foldsMenuRow: boolean }): HeaderCondense {
  const bar = "var(--hdr-phone-bar) - var(--hdr-phone-bar-condensed)";
  if (!spec) {
    const classicBar = "var(--hdr-classic-bar) - var(--hdr-classic-bar-condensed)";
    return {
      phone: `calc(${bar})`,
      desktop: options.foldsMenuRow ? `calc(${classicBar} + var(--hdr-classic-menu-row))` : `calc(${classicBar})`,
    };
  }
  // Composed headers keep their computer rows as they are.
  return {
    phone: spec.phoneSearch === "sticky" ? `calc(${bar} + var(--hdr-phone-search-row))` : `calc(${bar})`,
    desktop: "0rem",
  };
}

/**
 * The geometry and the reserve as custom properties on #site-header.
 * HeaderLayout's CSS chooses `--nav-link-height` (fine or coarse pointer)
 * and `--hdr-condense-duration` (0s under reduced motion).
 */
export function headerGeometryStyle(condense: HeaderCondense): string {
  const { condense: motion, phoneBar, searchField, phoneSearchGap, classicBar, classicMenuRow } = HEADER_GEOMETRY;
  return [
    `--hdr-condense-motion: ${motion.duration}`,
    `--hdr-condense-easing: ${motion.easing}`,
    `--hdr-phone-bar: ${phoneBar.expanded}`,
    `--hdr-phone-bar-condensed: ${phoneBar.condensed}`,
    `--hdr-search-field: ${searchField}`,
    `--hdr-phone-search-row: calc(var(--hdr-search-field) + ${phoneSearchGap})`,
    `--hdr-classic-bar: ${classicBar.expanded}`,
    `--hdr-classic-bar-condensed: ${classicBar.condensed}`,
    `--nav-link-height-fine: ${classicMenuRow.link.fine}`,
    `--nav-link-height-coarse: ${classicMenuRow.link.coarse}`,
    `--hdr-classic-menu-row: calc(${classicMenuRow.border} + 2 * ${classicMenuRow.padding} + var(--nav-link-height))`,
    `--hdr-condense-phone: ${condense.phone}`,
    `--hdr-condense-desktop: ${condense.desktop}`,
  ].join("; ");
}

/** The spec for a composed header, with its settings applied (`cartTotal`). */
export function headerSpec(variant: string, settings: Record<string, unknown>): HeaderSpec | null {
  const spec = HEADER_SPECS[variant as keyof typeof HEADER_SPECS];
  if (!spec) return null;
  return typeof settings.cartTotal === "boolean" ? { ...spec, cartTotal: settings.cartTotal } : spec;
}
