/**
 * The header as data (theme block `header`): three layouts and the settings
 * that tune them (search, row tone, cart total), all drawn by
 * ComposedHeader.astro. Sizes follow the 4px scale; colours, radius and type
 * come from the theme tokens, never from here.
 *
 * Phones share one grammar whatever the layout: a 56px bar (menu, logo
 * centred, account, cart) that condenses to 48px on scroll, plus a search
 * row for `search-first` that folds away on scroll, so the sticky stack
 * stays under 120px.
 */
import type { StorefrontBlockVariant } from "@scalius/shared/storefront-theme";

export type HeaderVariant = StorefrontBlockVariant<"header">;

/**
 * The header's logo: the theme's logo image (`src`, "" for none: the store
 * name in text), the store name as its alt text and its computer width.
 */
export interface HeaderLogo {
  src: string;
  alt: string;
  width: number;
}

export interface HeaderSpec {
  layout: HeaderVariant;
  /** The main row wears the header colours (`headerTone`), not the page's. */
  toneRow: boolean;
  /** Where the desktop menu sits: in the main row, or its own row below. */
  menu: "inline" | "row";
  /** icon: a 44px button; field: a filled field; scoped: department select + field + button. */
  search: "icon" | "field" | "scoped";
  /** A running cart total beside the cart. */
  cartTotal: boolean;
  /** Phones: a full-width search row under the bar. */
  phoneSearch: "none" | "sticky";
  /** Phones: a scrolling row of top links under the header (not sticky). */
  phoneShortcuts: boolean;
  /** Desktop heights in rem: the main row and the menu row. */
  mainHeight: number;
  menuHeight: number;
}

const LAYOUTS: Record<HeaderVariant, Pick<HeaderSpec, "menu" | "phoneSearch" | "phoneShortcuts" | "mainHeight" | "menuHeight">> = {
  "inline-nav": { menu: "inline", phoneSearch: "none", phoneShortcuts: false, mainHeight: 5, menuHeight: 0 },
  "search-first": { menu: "row", phoneSearch: "sticky", phoneShortcuts: true, mainHeight: 4.5, menuHeight: 3 },
  "centered-logo": { menu: "row", phoneSearch: "none", phoneShortcuts: false, mainHeight: 5, menuHeight: 3 },
};

/**
 * What changes height when the page scrolls. The sticky header condenses (a
 * shorter bar; the phone search row folds away), and the page under it must
 * not move: while condensed the header keeps its expanded height in the flow
 * as a bottom margin (CLS 0). The rows paint with these lengths and the
 * reserve is built from the same custom properties, so the two can never
 * drift apart; rows and reserve animate with one shared transition, so
 * their sum is the same in every frame.
 */
export const HEADER_GEOMETRY = {
  /** The one transition every condensing height and the reserve use. */
  condense: { duration: "300ms", easing: "cubic-bezier(0.25, 0.1, 0.25, 1)" },
  /** Every phone bar: 56px, 48px once scrolled. */
  phoneBar: { expanded: "3.5rem", condensed: "3rem" },
  /** A header search field (HeaderSearch), and the space under the phone search row. */
  searchField: "2.75rem",
  phoneSearchGap: "0.5rem",
  /** A menu link's height (DesktopNav; touch screens keep 44px targets). */
  navLink: { fine: "2.5rem", coarse: "2.75rem" },
} as const;

export interface HeaderCondense {
  /** The height the header loses on scroll below 64rem, as a CSS length. */
  phone: string;
}

/** How much a header condenses on scroll: the reserve that keeps the page still. */
export function headerCondense(spec: HeaderSpec): HeaderCondense {
  const bar = "var(--hdr-phone-bar) - var(--hdr-phone-bar-condensed)";
  return { phone: spec.phoneSearch === "sticky" ? `calc(${bar} + var(--hdr-phone-search-row))` : `calc(${bar})` };
}

/**
 * The geometry and the reserve as custom properties on #site-header.
 * HeaderLayout's CSS chooses `--nav-link-height` (fine or coarse pointer)
 * and `--hdr-condense-duration` (0s under reduced motion).
 */
export function headerGeometryStyle(condense: HeaderCondense): string {
  const { condense: motion, phoneBar, searchField, phoneSearchGap, navLink } = HEADER_GEOMETRY;
  return [
    `--hdr-condense-motion: ${motion.duration}`,
    `--hdr-condense-easing: ${motion.easing}`,
    `--hdr-phone-bar: ${phoneBar.expanded}`,
    `--hdr-phone-bar-condensed: ${phoneBar.condensed}`,
    `--hdr-search-field: ${searchField}`,
    `--hdr-phone-search-row: calc(var(--hdr-search-field) + ${phoneSearchGap})`,
    `--nav-link-height-fine: ${navLink.fine}`,
    `--nav-link-height-coarse: ${navLink.coarse}`,
    `--hdr-condense-phone: ${condense.phone}`,
  ].join("; ");
}

/** The spec for a header layout with its settings applied. */
export function headerSpec(variant: string, settings: Record<string, unknown>): HeaderSpec {
  const layout: HeaderVariant = variant === "search-first" || variant === "centered-logo" ? variant : "inline-nav";
  const search = settings.search === "field" || settings.search === "scoped" ? settings.search : "icon";
  return {
    layout,
    ...LAYOUTS[layout],
    toneRow: settings.rowTone === "header",
    search: layout === "search-first" && search === "icon" ? "field" : search,
    cartTotal: settings.cartTotal === true,
  };
}
