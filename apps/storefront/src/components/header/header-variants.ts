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
 * What changes height when the page scrolls, in rem. The sticky header
 * condenses (a shorter bar; the phone search row and the classic dropdown
 * row fold away), and the page under it must not move: the header keeps its
 * expanded height in the flow as a bottom margin while condensed (CLS 0).
 * The heights the CSS paints and the reserve both come from here.
 */
export const HEADER_GEOMETRY = {
  /** Every phone bar: 56px, 48px once scrolled. */
  phoneBar: { expanded: 3.5, condensed: 3 },
  /** Composed headers' phone search row: a 44px field and 8px under it. */
  phoneSearchRow: 3.25,
  /** The classic header's main row on computers: 72px, 64px once scrolled. */
  classicBar: { expanded: 4.5, condensed: 4 },
  /** The classic header's dropdown row (it folds into the bar on scroll). */
  classicMenuRow: 3.5625,
} as const;

export interface HeaderCondense {
  /** Height the header loses on scroll below 64rem (rem). */
  phone: number;
  /** ...and from 64rem. */
  desktop: number;
}

/**
 * How much a header condenses on scroll: the reserve that keeps the page
 * still. `spec` null is the classic header; `foldsMenuRow` its dropdown row
 * folding into the bar.
 */
export function headerCondense(spec: HeaderSpec | null, options: { foldsMenuRow: boolean }): HeaderCondense {
  const { phoneBar, phoneSearchRow, classicBar, classicMenuRow } = HEADER_GEOMETRY;
  const bar = phoneBar.expanded - phoneBar.condensed;
  if (!spec) {
    return {
      phone: bar,
      desktop: classicBar.expanded - classicBar.condensed + (options.foldsMenuRow ? classicMenuRow : 0),
    };
  }
  // Composed headers keep their computer rows as they are.
  return { phone: bar + (spec.phoneSearch === "sticky" ? phoneSearchRow : 0), desktop: 0 };
}

/** The geometry and the reserve as CSS custom properties (on #site-header). */
export function headerGeometryStyle(condense: HeaderCondense): string {
  const { phoneBar, phoneSearchRow, classicBar, classicMenuRow } = HEADER_GEOMETRY;
  return [
    `--hdr-phone-bar: ${phoneBar.expanded}rem`,
    `--hdr-phone-bar-condensed: ${phoneBar.condensed}rem`,
    `--hdr-phone-search-row: ${phoneSearchRow}rem`,
    `--hdr-classic-bar: ${classicBar.expanded}rem`,
    `--hdr-classic-bar-condensed: ${classicBar.condensed}rem`,
    `--hdr-classic-menu-row: ${classicMenuRow}rem`,
    `--hdr-condense-phone: ${condense.phone}rem`,
    `--hdr-condense-desktop: ${condense.desktop}rem`,
  ].join("; ");
}

/** The spec for a composed header, with its settings applied (`cartTotal`). */
export function headerSpec(variant: string, settings: Record<string, unknown>): HeaderSpec | null {
  const spec = HEADER_SPECS[variant as keyof typeof HEADER_SPECS];
  if (!spec) return null;
  return typeof settings.cartTotal === "boolean" ? { ...spec, cartTotal: settings.cartTotal } : spec;
}
