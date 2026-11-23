// The buyer's private pages as named host parts (docs: packages/plugin-sdk/docs/private-pages.md).
//
// Each private page is drawn by the host from named parts. A part is core
// markup with stable `data-part` hooks inside it; a theme arranges parts,
// its own content blocks and the apps' extension targets in a tree of
// layout nodes (private-arrangement.ts). A theme never writes a selector
// for a host part: each page names its style targets (`styles`), the parts'
// elements a theme gives a look through typed tokens (private-tokens.ts),
// and the host writes all the CSS that reads them; in token mode every
// target is a row of the page's colour table, which drives the CSS and the
// contrast check alike. The theme's own
// stylesheet (private-css.ts) reaches only inside free regions (its content
// blocks, its header and footer, the inside of an app's block), which the
// host seals. No theme or app script ever runs on these pages. Each page says which parts a buyer must see and do (mandatory:
// every arrangement holds them exactly once) and which a theme may leave out.
// A repeated unit (a cart line) has its own arrangement of its sub-parts.
//
// This module is data only (no zod): the dashboard and the storefront's
// browser code read it. The anatomy is a versioned contract: the anatomy
// test pins every page, part and hook, and `PRIVATE_ANATOMY_VERSION` rises
// whenever a mandatory part or target is added, so a stored arrangement
// written before it gets the new part in its default place on read.
//
// Registering a page: add a `PrivatePageSpec` below (its root, frames,
// parts, targets, layouts, default layout, items, style targets, labels and
// icons) and add it to `PRIVATE_PAGES`. Its default layout must hold every
// mandatory part and target exactly once. Nothing else is per page.

/** Rises when a page gains a mandatory part or target (a stored arrangement then fills it in on read). */
export const PRIVATE_ANATOMY_VERSION = 1 as const;

/**
 * The host's layout nodes. `stack`: one column. `columns`: one column on
 * phones, side by side from 64rem. `grid`: a grid the theme's stylesheet
 * shapes. `group`: a box with no layout of its own. `fold` (the cart page):
 * on phones its children fold behind a bar that states the total. `scroll`
 * (the drawer): the region that scrolls between the drawer's fixed parts.
 */
export const PRIVATE_LAYOUT_KINDS = ["stack", "columns", "grid", "group", "fold", "scroll"] as const;
export type PrivateLayoutKind = (typeof PRIVATE_LAYOUT_KINDS)[number];

/** A theme content block's tone (the buyer UI's tones). */
export const PRIVATE_CONTENT_TONES = ["neutral", "info", "success", "warning", "critical"] as const;
export type PrivateContentTone = (typeof PRIVATE_CONTENT_TONES)[number];

/** Words in each language the theme writes them in, keyed by base language (`en`, `bn`). */
export type PrivateWords = Record<string, string>;

/** A file the theme's app ships in `public/` (served from the store's own origin). */
export interface PrivateAssetRef {
  app: string;
  file: string;
}

/** A theme's own script-free content (the buyer UI's building blocks, drawn by the host). */
export type PrivateContentBlock =
  | { kind: "heading"; text: PrivateWords; level?: 2 | 3 }
  | { kind: "text"; text: PrivateWords; tone?: PrivateContentTone }
  | { kind: "link"; text: PrivateWords; href: string }
  | { kind: "image"; image: PrivateAssetRef; alt: PrivateWords; width: number; height: number }
  | { kind: "banner"; tone: PrivateContentTone; title?: PrivateWords; text?: PrivateWords }
  | { kind: "disclosure"; summary: PrivateWords; text: PrivateWords }
  | { kind: "divider" };

/** One node of an arrangement. */
export type PrivateNode =
  | { type: "layout"; layout: PrivateLayoutKind; hook?: string; children: PrivateNode[] }
  | { type: "part"; part: string; variant?: string }
  | { type: "target"; target: string }
  | { type: "content"; content: PrivateContentBlock; hook?: string };

export interface PrivatePartSpec {
  /** A buyer must see it (or use it): every arrangement holds it exactly once. */
  readonly mandatory: boolean;
  /** Its closed variants, the first the default. */
  readonly variants?: readonly [string, ...string[]];
  /** Its `data-part` hooks, its own name first (the anatomy contract; no theme selector reaches them). */
  readonly hooks: readonly string[];
}

/**
 * The tokens a theme may set (private-tokens.ts says each one's type,
 * bounds and the CSS the host writes from it). A style target or a layout
 * node takes the ones it lists.
 */
export const PRIVATE_TOKEN_NAMES = [
  "background", "gradient", "text", "muted", "link", "error", "placeholder", "ring", "invalid", "border", "border-width", "border-style", "radius", "shadow", "padding", "gap",
  "font", "weight", "size", "case", "tracking", "align", "clamp",
  "columns", "columns-wide", "width", "height", "width-wide", "height-wide", "fit", "max-width",
] as const;
export type PrivateTokenName = (typeof PRIVATE_TOKEN_NAMES)[number];

/** A palette role (contrast.ts `STOREFRONT_THEME_COLOR_KEYS`), as the anatomy names one. */
export type PrivatePaletteRole =
  | "background" | "foreground" | "card" | "card-foreground" | "popover" | "popover-foreground" | "primary" | "primary-foreground"
  | "secondary" | "secondary-foreground" | "muted" | "muted-foreground" | "accent" | "accent-foreground" | "destructive" | "destructive-foreground"
  | "border" | "input" | "ring";

/**
 * What a style target is to the colour table (private-tokens.ts): a `box`
 * (a surface that holds other things: fields and buttons are checked
 * against it), a `field` (its own surface, words and placeholder, and a
 * border, focus ring and error border that read on what is around it), a
 * `control` (a button, a stepper, a toggle: its focus ring reads on what is
 * around it) or `text` (words on a surface).
 */
export type PrivateStyleKind = "box" | "field" | "control" | "text";

/**
 * An element of a host part a theme gives a look by tokens. The host writes
 * `<root> <selector> { … }` from the validated values; the theme never
 * writes a selector here. In token mode every target is one row of the
 * page's colour table (private-tokens.ts): its surface, the colour of its own
 * words (`ink`) and of its muted, link and error words, its border and focus
 * ring, each the theme's token where given, else a default that reads on the
 * surface beneath.
 */
export interface PrivateStyleSpec {
  /** The host's selector, inside the page root (or the whole document, `absolute`: the dialogs, the body). */
  readonly selector: string;
  readonly absolute?: boolean;
  readonly tokens: readonly PrivateTokenName[];
  readonly kind: PrivateStyleKind;
  /** Its default surface: a palette role, or `under` (none of its own: the surface of the row it sits in shows). */
  readonly surface: PrivatePaletteRole | "under";
  /** The palette role of its own words (its `text` token replaces it). */
  readonly ink: PrivatePaletteRole;
  /**
   * Where it sits, which says what is beneath it: inside the target `on`, as
   * the part `part` where the arrangement puts it (of the unit `item`), in
   * the host layout `layout`, or (none of these) anywhere: a field or button
   * the host draws in many places, checked on every box of the page.
   */
  readonly on?: string;
  readonly part?: string;
  readonly item?: string;
  readonly layout?: PrivateLayoutKind;
}

/** The tokens a theme's layout node takes (`@<hook>` in `privatePages.tokens`). */
export const PRIVATE_LAYOUT_TOKENS = ["background", "gradient", "border", "border-width", "border-style", "radius", "shadow", "padding", "gap", "columns", "columns-wide"] as const satisfies readonly PrivateTokenName[];

/** A page, or a repeated unit inside one (a cart line). */
export interface PrivateUnitSpec {
  readonly parts: Readonly<Record<string, PrivatePartSpec>>;
  /** The apps' extension targets here: each is placed exactly once (a missing one goes to its default place). */
  readonly targets: readonly string[];
  /** The layout nodes the unit takes. */
  readonly layouts: readonly PrivateLayoutKind[];
  /** The layout the host draws without an arrangement: today's page. */
  readonly layout: readonly PrivateNode[];
}

/**
 * A host label a theme may change. Words that name an action or an amount
 * (go back, confirm, check out, subtotal) are chosen from the host's
 * variants (`variants`), each translated by core in the store's copy, so a
 * theme can never make "Go back" confirm or a subtotal read as the total.
 * Words that describe (a heading, an empty state) are the theme's own plain
 * text, per language, up to `max` characters.
 */
export type PrivateLabelSpec = { readonly max: number; readonly variants?: undefined } | { readonly variants: readonly [string, ...string[]]; readonly max?: undefined };

export interface PrivatePageSpec extends PrivateUnitSpec {
  /** The elements a theme styles by tokens, by name (`page` is the page itself). */
  readonly styles: Readonly<Record<string, PrivateStyleSpec>>;
  /** The `data-private` value of its root (the stylesheet's scope). */
  readonly root: string;
  /** The page frame's closed variants, the first the default. */
  readonly frames?: readonly [string, ...string[]];
  /** The hooks a host layout draws inside itself (the fold's bar and body). */
  readonly layoutHooks?: Partial<Record<PrivateLayoutKind, readonly string[]>>;
  /** What a host layout may hold (parts and targets by name; content blocks and plain layouts always). */
  readonly layoutContents?: Partial<Record<PrivateLayoutKind, readonly string[]>>;
  /** Repeated units, by name. */
  readonly items: Readonly<Record<string, PrivateUnitSpec>>;
  /** Host labels the theme may change: a host variant for an action or an amount, its own words for the rest. */
  readonly labels: Readonly<Record<string, PrivateLabelSpec>>;
  /** Host icons the theme may replace with its own image. */
  readonly icons: readonly string[];
}

const part = (mandatory: boolean, hooks: readonly string[]): PrivatePartSpec => ({ mandatory, hooks });
const p = (name: string): PrivateNode => ({ type: "part", part: name });
const t = (target: string): PrivateNode => ({ type: "target", target });
const l = (layout: PrivateLayoutKind, children: PrivateNode[]): PrivateNode => ({ type: "layout", layout, children });

/** A cart line's sub-parts, shared by the cart page and the drawer (one anatomy, two default layouts). */
const CART_LINE_PARTS = {
  image: part(false, ["line-image"]),
  title: part(true, ["line-title"]),
  // The options, answers and fulfilment the buyer chose: what they are buying.
  details: part(true, ["line-details"]),
  // The apps' line inputs drawn by the host (a decision the buyer must make).
  inputs: part(true, ["line-inputs"]),
  quantity: part(true, ["line-quantity"]),
  price: part(true, ["line-price"]),
  remove: part(true, ["line-remove"]),
  limit: part(true, ["line-limit"]),
  issue: part(true, ["line-issue"]),
  rule: part(true, ["line-rule"]),
} as const satisfies Record<string, PrivatePartSpec>;

/** The line's own hook (its root). */
export const PRIVATE_LINE_HOOK = "line";

const TEXT_TOKENS = ["text", "font", "weight", "size", "case", "tracking"] as const satisfies readonly PrivateTokenName[];
const BOX_TOKENS = ["background", "gradient", "text", "muted", "link", "error", "border", "border-width", "border-style", "radius", "shadow", "padding"] as const satisfies readonly PrivateTokenName[];
const BUTTON_TOKENS = ["background", "gradient", "text", "border", "border-width", "border-style", "radius", "shadow", "ring", "font", "weight", "size", "case", "tracking"] as const satisfies readonly PrivateTokenName[];
const FIELD_TOKENS = ["background", "text", "placeholder", "border", "ring", "invalid", "border-width", "radius"] as const satisfies readonly PrivateTokenName[];

/** The cart page's style targets (and the store's dialogs over it), outer before inner. */
const CART_STYLES: Record<string, PrivateStyleSpec> = {
  // The page's paint (F2: a gradient behind everything) and its frame's width.
  page: { selector: "body[data-private-body]", absolute: true, tokens: ["background", "gradient", "text", "muted", "link", "error"], kind: "box", surface: "background", ink: "foreground" },
  frame: { selector: "", tokens: ["max-width"], kind: "box", surface: "under", ink: "foreground", on: "page" },
  // Every filled button the host draws without a target of its own (bg-primary), and every field, on the page and in its dialogs.
  action: { selector: ':is([data-private="cart"],[data-private="dialog"]) .bg-primary', absolute: true, tokens: [...BUTTON_TOKENS], kind: "control", surface: "primary", ink: "primary-foreground" },
  input: { selector: ':is([data-private="cart"],[data-private="dialog"]) :is(input:not([type="checkbox"],[type="radio"],[type="hidden"]),select,textarea)', absolute: true, tokens: [...FIELD_TOKENS], kind: "field", surface: "background", ink: "foreground" },
  notice: { selector: '[data-part="notice"]', tokens: ["background", "text", "muted", "link", "error", "border", "border-width", "radius"], kind: "box", surface: "under", ink: "foreground", part: "notices" },
  lines: { selector: '[data-part="lines"]', tokens: [...BOX_TOKENS], kind: "box", surface: "card", ink: "foreground", part: "lines" },
  "lines-heading": { selector: '[data-part="lines-heading"]', tokens: [...TEXT_TOKENS], kind: "text", surface: "under", ink: "foreground", on: "lines" },
  "cart-empty": { selector: '[data-part="cart-empty"]', tokens: ["text", "muted"], kind: "text", surface: "under", ink: "foreground", on: "lines" },
  line: { selector: '[data-part="line"]', tokens: ["background", "border", "border-width", "border-style", "radius", "padding"], kind: "box", surface: "under", ink: "foreground", on: "lines" },
  "line-image": { selector: '[data-part="line-image"]', tokens: ["width", "height", "width-wide", "height-wide", "radius", "background", "border", "border-width", "border-style", "fit"], kind: "text", surface: "muted", ink: "foreground", item: "line", part: "image" },
  "line-title": { selector: '[data-part="line-title"]', tokens: [...TEXT_TOKENS, "clamp"], kind: "text", surface: "under", ink: "foreground", item: "line", part: "title" },
  "line-details": { selector: '[data-part="line-details"]', tokens: ["text", "size"], kind: "text", surface: "under", ink: "muted-foreground", item: "line", part: "details" },
  "line-price": { selector: '[data-part="line-price"]', tokens: ["text", "muted", "font", "weight", "size", "align"], kind: "text", surface: "under", ink: "foreground", item: "line", part: "price" },
  "line-quantity": { selector: '[data-part="line-quantity"]', tokens: ["background", "text", "border", "border-width", "border-style", "radius", "ring"], kind: "control", surface: "under", ink: "foreground", item: "line", part: "quantity" },
  "line-remove": { selector: '[data-part="line-remove"]', tokens: ["text", "radius", "ring"], kind: "control", surface: "under", ink: "muted-foreground", item: "line", part: "remove" },
  "fold-toggle": { selector: '[data-part="fold-toggle"]', tokens: ["background", "text", "border", "border-width", "radius", "shadow", "ring"], kind: "control", surface: "card", ink: "foreground", layout: "fold" },
  summary: { selector: '[data-part="summary"]', tokens: [...BOX_TOKENS, "gap"], kind: "box", surface: "card", ink: "foreground", part: "summary" },
  "summary-rows": { selector: '[data-summary-row]:not([data-summary-row="total"])', tokens: ["text", "size"], kind: "text", surface: "under", ink: "muted-foreground", on: "summary" },
  "summary-total": { selector: '[data-summary-row="total"]', tokens: [...TEXT_TOKENS], kind: "text", surface: "under", ink: "foreground", on: "summary" },
  "details-form": { selector: '[data-part="details-form"]', tokens: [...BOX_TOKENS], kind: "box", surface: "card", ink: "foreground", part: "details" },
  "section-heading": { selector: ':is([data-part="contact"],[data-part="delivery"]) h2', tokens: [...TEXT_TOKENS], kind: "text", surface: "under", ink: "foreground", on: "details-form" },
  submit: { selector: '[data-part="details-submit"]', tokens: [...BUTTON_TOKENS], kind: "control", surface: "primary", ink: "primary-foreground", on: "details-form" },
  legal: { selector: '[data-part="legal"]', tokens: ["text", "size", "align"], kind: "text", surface: "under", ink: "muted-foreground", on: "details-form" },
  // The store's dialogs over the page (confirmation, sign-in): their surface, words, fields and buttons.
  dialog: { selector: '[data-private="dialog"]', absolute: true, tokens: ["background", "text", "muted", "link", "error", "border", "border-width", "radius", "shadow"], kind: "box", surface: "card", ink: "foreground", on: "page" },
  "dialog-back": { selector: '[data-private="dialog"] [data-part="dialog-back"]', absolute: true, tokens: ["background", "text", "border", "border-width", "radius", "ring", "weight"], kind: "control", surface: "under", ink: "foreground", on: "dialog" },
  "dialog-confirm": { selector: '[data-private="dialog"] [data-part="dialog-confirm"]', absolute: true, tokens: [...BUTTON_TOKENS], kind: "control", surface: "primary", ink: "primary-foreground", on: "dialog" },
  // The host's search in the theme header's frame (`privatePages.search`), never inside the theme's region.
  search: { selector: '[data-host="search"]', absolute: true, tokens: [...FIELD_TOKENS], kind: "field", surface: "background", ink: "foreground", on: "page" },
};

/** The cart page: the information step (lines, totals, the details form and its submit). */
const CART_PAGE: PrivatePageSpec = {
  root: "cart",
  frames: ["standard", "narrow"],
  layoutHooks: { fold: ["fold-toggle", "fold-body"] },
  // The fold starts closed on phones: it may hold the cart, never what a buyer must fill in or read first.
  layoutContents: { fold: ["lines", "summary", "discount", "cart.page.summary"] },
  parts: {
    progress: part(false, ["progress"]),
    notices: part(true, ["notice"]),
    lines: part(true, ["lines", "lines-heading", "lines-continue", "lines-loading", "lines-list", "lines-clear", "lines-undo", "cart-empty", "cart-empty-icon"]),
    // Its money rows carry `data-summary-row` (subtotal, add-on, delivery, discount, tax, total), as on every surface.
    summary: part(true, ["summary", "summary-validation"]),
    discount: part(false, ["discount"]),
    details: part(true, ["details", "details-sign-in", "details-form", "contact", "delivery", "details-errors", "details-submit", "legal"]),
    empty: part(false, ["empty-extras"]),
  },
  targets: ["cart.page.summary", "cart.page.below"],
  layouts: ["stack", "columns", "grid", "group", "fold"],
  styles: CART_STYLES,
  layout: [
    p("progress"),
    p("notices"),
    l("columns", [
      l("stack", [
        l("fold", [p("lines"), p("summary"), p("discount"), t("cart.page.summary")]),
        t("cart.page.below"),
        p("empty"),
      ]),
      p("details"),
    ]),
  ],
  items: {
    line: {
      parts: CART_LINE_PARTS,
      targets: ["cart.line.after"],
      layouts: ["stack", "columns", "grid", "group"],
      layout: [
        p("image"),
        l("stack", [
          l("columns", [l("stack", [p("title"), p("details"), p("inputs"), t("cart.line.after")]), p("remove")]),
          l("columns", [p("quantity"), p("price")]),
          p("limit"),
          p("issue"),
          p("rule"),
        ]),
      ],
    },
  },
  labels: {
    "cart.heading": { max: 60 },
    "cart.continue": { variants: ["continue-shopping", "keep-shopping", "back-to-store"] },
    "cart.empty": { max: 80 },
    "cart.emptyText": { max: 200 },
    "cart.subtotal": { variants: ["subtotal", "items-total"] },
    "cart.showSummary": { variants: ["show-summary", "show-cart"] },
    "cart.hideSummary": { variants: ["hide-summary", "hide-cart"] },
    "dialog.goBack": { variants: ["go-back", "cancel"] },
    "dialog.confirm": { variants: ["confirm", "continue-checkout", "agree-and-continue"] },
  },
  icons: ["cart.empty"],
};

/** The cart drawer: the cart over any page, opened in the browser. */
const CART_DRAWER: PrivatePageSpec = {
  root: "cart-drawer",
  frames: ["standard", "wide"],
  layoutHooks: { scroll: ["drawer-scroll"] },
  parts: {
    header: part(true, ["drawer-header", "drawer-title", "drawer-count", "drawer-close"]),
    added: part(false, ["drawer-added"]),
    lines: part(true, ["drawer-lines", "drawer-empty", "drawer-empty-icon"]),
    recommendations: part(false, ["drawer-recommendations"]),
    undo: part(true, ["drawer-undo"]),
    offers: part(false, ["drawer-offers"]),
    // Its money rows carry `data-summary-row`; `drawer-summary` is the box of rows above the total.
    summary: part(true, ["drawer-summary", "drawer-total", "drawer-blocked"]),
    actions: part(true, ["drawer-checkout", "drawer-actions", "drawer-view-cart", "drawer-continue"]),
  },
  targets: ["cart_drawer.footer"],
  layouts: ["stack", "columns", "grid", "group", "scroll"],
  // It opens over public pages and is part of them: its look is the public stylesheet's.
  styles: {},
  layout: [
    p("header"),
    p("added"),
    l("scroll", [p("lines"), p("recommendations")]),
    p("undo"),
    p("offers"),
    l("group", [p("summary"), t("cart_drawer.footer"), p("actions")]),
  ],
  items: {
    line: {
      parts: CART_LINE_PARTS,
      targets: ["cart.line.after"],
      layouts: ["stack", "columns", "grid", "group"],
      layout: [
        p("image"),
        l("stack", [
          l("columns", [l("stack", [p("title"), p("details"), p("inputs"), t("cart.line.after"), p("issue"), p("rule")]), p("price")]),
          l("columns", [p("quantity"), p("remove")]),
          p("limit"),
        ]),
      ],
    },
  },
  labels: {
    "drawer.title": { max: 40 },
    "drawer.checkout": { variants: ["checkout", "proceed-to-checkout"] },
    "drawer.viewCart": { variants: ["view-cart", "go-to-cart"] },
    "drawer.continue": { variants: ["continue-shopping", "keep-shopping"] },
    "drawer.empty": { max: 80 },
    "drawer.startShopping": { variants: ["start-shopping", "browse-products", "continue-shopping"] },
  },
  icons: ["drawer.empty"],
};

/**
 * Every private page the model draws, by its key in the theme document's
 * `privatePages.pages`. The checkout, the receipt and the account register
 * here as they convert.
 */
export const PRIVATE_PAGES = {
  cart: CART_PAGE,
  cartDrawer: CART_DRAWER,
} as const satisfies Record<string, PrivatePageSpec>;

export type PrivatePageKey = keyof typeof PRIVATE_PAGES;
export const PRIVATE_PAGE_KEYS = Object.keys(PRIVATE_PAGES) as PrivatePageKey[];

/** The hook every private surface's root carries (`data-private="<root>"`): the stylesheet's scope. */
export const PRIVATE_SCOPE_ATTRIBUTE = "data-private";
/** The hook on each part's elements. */
export const PRIVATE_PART_ATTRIBUTE = "data-part";
/** A layout node's or content block's theme hook (`data-hook="<name>"`). */
export const PRIVATE_HOOK_ATTRIBUTE = "data-hook";
/** A theme hook: lowercase words joined by hyphens (`studio-summary`). */
export const PRIVATE_HOOK_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+){0,5}$/;
export const PRIVATE_HOOK_MAX = 40;

/** Surfaces besides the pages that carry the scope: the store's dialogs and the theme's chrome there. */
export const PRIVATE_SCOPES = ["dialog", "header", "footer"] as const;

/**
 * Free regions: boxes the host seals (nothing inside paints, lays out,
 * widens the page or acts outside them) and the only places the theme's
 * stylesheet reaches, strictly inside the wrapper (`data-free`): the
 * theme's content blocks (`block`, with their `data-hook`) and its header
 * and footer (`header`, `footer`). Nothing of the host's is ever inside one:
 * the host's search sits beside the theme's header (`PRIVATE_SEARCH_PLACES`).
 */
export const PRIVATE_FREE_REGIONS = ["block", "header", "footer"] as const;

/**
 * Where the host's search form sits in the header's frame on a private page
 * with the theme's chrome (`privatePages.search`): before or after the
 * theme's header region, or (unset) nowhere. Its look is the `search` target's
 * tokens; whatever search form the theme's header draws is dropped.
 */
export const PRIVATE_SEARCH_PLACES = ["before", "after"] as const;
export type PrivateSearchPlace = (typeof PRIVATE_SEARCH_PLACES)[number];

/** The most content blocks a page holds, and the most before and after its last mandatory part (each is at most 30rem tall). */
export const PRIVATE_CONTENT_LIMITS = { perPage: 8, beforeLastMandatory: 3, afterLastMandatory: 3 } as const;

/** An app node kind's style target (`ui.<kind>`): what it is to the colour table, by tone. */
export interface PrivateBuyerUiStyle {
  /** The node's selector inside its block (`data-ui`, with `data-tone` added per tone). */
  readonly kind: string;
  readonly tones?: readonly PrivateContentTone[];
  readonly tokens: readonly PrivateTokenName[];
  /** Null for a node that draws no colour (a row of nodes): it has no row in the table. */
  readonly style: PrivateStyleKind | null;
  /** The palette role of its own words, per tone (`critical` words are the error colour). */
  readonly ink?: PrivatePaletteRole;
  readonly toneInk?: Partial<Record<PrivateContentTone, PrivatePaletteRole>>;
}

/**
 * An app's buyer UI block is host-drawn from typed nodes: a host part. A
 * theme gives each node kind a look by tokens under `ui.<kind>`, narrowed by
 * tone (`ui.banner.warning`), app (`@acme.protection`) and target
 * (`/cart.line.after`). Each kind and tone has a row in the colour table at
 * every one of the page's targets, on whatever that target sits on.
 */
export const PRIVATE_BUYER_UI_STYLES: Readonly<Record<string, PrivateBuyerUiStyle>> = {
  banner: { kind: '[data-ui="banner"]', tones: PRIVATE_CONTENT_TONES, tokens: ["background", "text", "border", "border-width", "radius", "shadow", "padding"], style: "box", ink: "foreground", toneInk: { critical: "destructive" } },
  button: { kind: ':is(a[data-ui="button"],[data-ui="button"]>button)', tokens: ["background", "text", "border", "border-width", "radius", "ring", "weight", "size", "case"], style: "control", ink: "foreground" },
  badge: { kind: '[data-ui="badge"]', tones: PRIVATE_CONTENT_TONES, tokens: ["background", "text", "border", "radius"], style: "text", ink: "foreground", toneInk: { critical: "destructive" } },
  text: { kind: '[data-ui="text"]', tokens: ["text", "size", "weight"], style: "text", ink: "foreground" },
  heading: { kind: '[data-ui="heading"]', tokens: ["text", "size", "weight", "font", "case"], style: "text", ink: "foreground" },
  disclosure: { kind: '[data-ui="disclosure"]', tokens: ["background", "text", "border", "radius"], style: "box", ink: "foreground" },
  row: { kind: ':is([data-ui="stack"],[data-ui="columns"])', tokens: ["gap"], style: null },
};
export type PrivateFreeRegion = (typeof PRIVATE_FREE_REGIONS)[number];
export const PRIVATE_FREE_ATTRIBUTE = "data-free";

/**
 * The store's dialogs over a private page (`data-private="dialog"`): the
 * confirmation an app's choice asks for, and sign-in (`sign-in`).
 */
export const PRIVATE_DIALOG_HOOKS = ["sign-in", "dialog-title", "dialog-text", "dialog-agree", "dialog-actions", "dialog-back", "dialog-confirm"] as const;

/**
 * An app's buyer UI block, wherever a private page draws it: its mount's
 * `data-buyer-ui-target`, the block's wrapper with `data-buyer-ui-app` (the
 * app's id) and each node's kind on `data-ui` (`banner`, `text`, `button`,
 * …) and tone on `data-tone`. A theme's content blocks carry the same kinds.
 */
export const PRIVATE_BUYER_UI_HOOKS = ["data-buyer-ui-target", "data-buyer-ui-app", "data-ui"] as const;

/** Every label key of every page, with its page and its spec. */
export function privateLabelKeys(): Array<{ page: PrivatePageKey; key: string; spec: PrivateLabelSpec }> {
  return PRIVATE_PAGE_KEYS.flatMap((page) => Object.entries(PRIVATE_PAGES[page].labels).map(([key, spec]) => ({ page, key, spec })));
}

/** Every variant any label offers (core's copy words each, in every language it translates). */
export function privateLabelVariants(): string[] {
  return [...new Set(privateLabelKeys().flatMap((entry) => entry.spec.variants ?? []))].sort();
}

/** Every icon key of every page. */
export function privateIconKeys(): string[] {
  return PRIVATE_PAGE_KEYS.flatMap((page) => [...PRIVATE_PAGES[page].icons]);
}

/**
 * The anatomy as one list of lines (`page part [mandatory] hook…`), the
 * contract the anatomy test pins and the theme docs print.
 */
export function privatePageAnatomy(): string[] {
  const lines: string[] = [];
  const unit = (prefix: string, spec: PrivateUnitSpec) => {
    for (const [name, entry] of Object.entries(spec.parts)) {
      lines.push(`${prefix} part ${name}${entry.mandatory ? " mandatory" : ""}${entry.variants ? ` variants=${entry.variants.join("|")}` : ""} hooks=${entry.hooks.join(",")}`);
    }
    for (const target of spec.targets) lines.push(`${prefix} target ${target}`);
    lines.push(`${prefix} layouts ${spec.layouts.join(",")}`);
  };
  for (const page of PRIVATE_PAGE_KEYS) {
    const spec: PrivatePageSpec = PRIVATE_PAGES[page];
    lines.push(`${page} root ${PRIVATE_SCOPE_ATTRIBUTE}=${spec.root}${spec.frames ? ` frames=${spec.frames.join("|")}` : ""}`);
    unit(page, spec);
    for (const [kind, hooks] of Object.entries(spec.layoutHooks ?? {})) lines.push(`${page} layout ${kind} hooks=${hooks.join(",")}`);
    for (const [kind, names] of Object.entries(spec.layoutContents ?? {})) lines.push(`${page} layout ${kind} holds=${names.join(",")}`);
    for (const [name, style] of Object.entries(spec.styles)) lines.push(`${page} style ${name} ${style.absolute ? "" : "<root> "}${style.selector || "<root>"} tokens=${style.tokens.join(",")}`);
    for (const [name, item] of Object.entries(spec.items)) {
      lines.push(`${page}.${name} root ${PRIVATE_PART_ATTRIBUTE}=${PRIVATE_LINE_HOOK}`);
      unit(`${page}.${name}`, item);
    }
    for (const [key, label] of Object.entries(spec.labels)) lines.push(`${page} label ${key} ${label.variants ? `variants=${label.variants.join("|")}` : `max=${label.max}`}`);
    for (const icon of spec.icons) lines.push(`${page} icon ${icon}`);
  }
  lines.push(`dialog root ${PRIVATE_SCOPE_ATTRIBUTE}=dialog hooks=${PRIVATE_DIALOG_HOOKS.join(",")}`);
  lines.push(`buyer-ui attributes=${PRIVATE_BUYER_UI_HOOKS.join(",")}`);
  lines.push(`chrome roots ${PRIVATE_SCOPE_ATTRIBUTE}=header|footer search=${PRIVATE_SEARCH_PLACES.join("|")}`);
  lines.push(`layout tokens=${PRIVATE_LAYOUT_TOKENS.join(",")}`);
  for (const [kind, style] of Object.entries(PRIVATE_BUYER_UI_STYLES)) lines.push(`buyer-ui style ui.${kind}${style.tones ? `[.${style.tones.join("|")}]` : ""}[@<app>][/<target>] ${style.kind} tokens=${style.tokens.join(",")}`);
  lines.push(`free regions ${PRIVATE_FREE_ATTRIBUTE}=${PRIVATE_FREE_REGIONS.join("|")}`);
  return lines;
}
