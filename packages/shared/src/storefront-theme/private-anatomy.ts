// The buyer's private pages as named host parts (docs: packages/plugin-sdk/docs/private-pages.md).
//
// Each private page is drawn by the host from named parts. A part is core
// markup with stable `data-part` hooks inside it; a theme arranges parts
// and the apps' extension targets in a tree of layout nodes
// (private-arrangement.ts). A theme writes no markup and no CSS here: each
// page names its style targets (`styles`), the parts' elements a theme gives
// a look through typed tokens (private-tokens.ts), and the host writes all
// the CSS that reads them; in token mode every target is a row of the page's
// colour table, which drives the CSS and the contrast check alike. No theme
// or app script ever runs on these pages. Each page says which parts a buyer
// must see and do (mandatory: every arrangement holds them exactly once) and
// which a theme may leave out.
// A repeated unit (a cart line) has its own arrangement of its sub-parts.
//
// The apps' node kinds and their style rows are in private-buyer-ui.ts.
//
// This module is data only (no zod): the dashboard and the storefront's
// browser code read it. The anatomy is a versioned contract: the anatomy
// test pins every page, part and hook, and `PRIVATE_ANATOMY_VERSION` rises
// whenever a mandatory part or target or a reading order is added, so a
// stored arrangement written before it gets the new part in its default
// place (and its parts in that order) on read.
//
// Registering a page: add a `PrivatePageSpec` below (its root, frames,
// parts, targets, layouts, default layout, items, style targets, labels and
// icons) and add it to `PRIVATE_PAGES`. Its default layout must hold every
// mandatory part and target exactly once. Nothing else is per page.

/** Rises when a page gains a mandatory part or target or a reading order (a stored arrangement then fills it in on read). */
export const PRIVATE_ANATOMY_VERSION = 3 as const;

/**
 * The host's layout nodes. `stack`: one column. `columns`: one column on
 * phones, side by side from 64rem. `grid`: a grid the theme
 * shapes by its hook's `columns` tokens. `group`: a box with no layout of its own. `fold` (the cart page):
 * on phones its children fold behind a bar that states the total. `scroll`
 * (the drawer): the region that scrolls between the drawer's fixed parts.
 */
export const PRIVATE_LAYOUT_KINDS = ["stack", "columns", "grid", "group", "fold", "scroll"] as const;
export type PrivateLayoutKind = (typeof PRIVATE_LAYOUT_KINDS)[number];

export { PRIVATE_UI_TONES, PRIVATE_BUYER_UI_STYLES, type PrivateUiTone, type PrivateBuyerUiStyle } from "./private-buyer-ui";
import { PRIVATE_BUYER_UI_STYLES } from "./private-buyer-ui";

/** Words in each language the theme writes them in, keyed by base language (`en`, `bn`). */
export type PrivateWords = Record<string, string>;

/** A file the theme's app ships in `public/` (served from the store's own origin): an icon's image. */
export interface PrivateAssetRef {
  app: string;
  file: string;
}

/** One node of an arrangement: a host layout, a host part or an apps' target. Nothing else draws. */
export type PrivateNode =
  | { type: "layout"; layout: PrivateLayoutKind; hook?: string; children: PrivateNode[] }
  | { type: "part"; part: string; variant?: string }
  | { type: "target"; target: string };

export interface PrivatePartSpec {
  /** A buyer must see it (or use it): every arrangement holds it exactly once. */
  readonly mandatory: boolean;
  /** Its closed variants, the first the default. */
  readonly variants?: readonly [string, ...string[]];
  /** Its `data-part` hooks, its own name first (the anatomy contract; no theme selector reaches them). */
  readonly hooks: readonly string[];
  /** It draws fields (the discount code, the details form, a line's inputs): they stand on its box, else on what it sits on. */
  readonly fields?: boolean;
}

/**
 * The tokens a theme may set (private-tokens.ts says each one's type,
 * bounds and the CSS the host writes from it). A style target or a layout
 * node takes the ones it lists.
 */
export const PRIVATE_TOKEN_NAMES = [
  "background", "gradient", "text", "muted", "link", "error", "placeholder", "ring", "invalid", "border", "border-width", "border-style", "radius", "shadow", "padding", "inset", "gap",
  "font", "weight", "size", "leading", "case", "tracking", "align", "clamp",
  "columns", "columns-wide", "width", "height", "width-wide", "height-wide", "fit", "max-width",
] as const;
export type PrivateTokenName = (typeof PRIVATE_TOKEN_NAMES)[number];

/** A palette role (contrast.ts `STOREFRONT_THEME_COLOR_KEYS`), as the anatomy names one. */
export type PrivatePaletteRole =
  | "background" | "foreground" | "card" | "card-foreground" | "popover" | "popover-foreground" | "primary" | "primary-foreground"
  | "secondary" | "secondary-foreground" | "muted" | "muted-foreground" | "accent" | "accent-foreground" | "destructive" | "destructive-foreground"
  | "border" | "input";

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
  /**
   * The variants of its `on` target's part under which its element sits
   * outside that part's box, on what the part stands on (the cart's heading
   * above its lines card): its row then stands on the part's parent row.
   */
  readonly outside?: readonly string[];
  readonly part?: string;
  readonly item?: string;
  readonly layout?: PrivateLayoutKind;
  /**
   * A field drawn in many places (`element`, the field elements): it has a
   * row in every box that holds fields (a part that draws them, a dialog, an
   * app's target), its marks checked on that box only, never on every box.
   */
  readonly element?: string;
  /** It holds fields (a dialog): a field style has a row in it. */
  readonly fields?: boolean;
  /**
   * The apps' targets the host draws inside its element, in fixed places (the
   * details form's `checkout.contact.after`): each node kind and tone there
   * has a row on this target's surface, and `ui.<kind>…/<target>` names them.
   */
  readonly targets?: readonly string[];
  /**
   * How a buyer tells the control or field from what is around it (WCAG
   * 1.4.11, 3:1 on what is around it): `fill`, a filled button (Place order,
   * Confirm), by its own surface; `edge`, an outlined one (a stepper, the
   * fold's bar, Go back) and every field, by its border, or by its own
   * surface where the theme draws no border (`border-width: 0`,
   * `border-style: none`).
   */
  readonly boundary?: "fill" | "edge";
  /**
   * Its words' size (px) and weight with no token of their own (the least
   * any of its elements draws as the side that must outrank, the most as the
   * side outranked), and the target whose `size` and `weight` also reach its
   * element when it sets none (`typeFrom`: the total's label takes the
   * total's; Place order and Confirm are filled buttons, so `action`'s).
   */
  readonly hostSize?: number;
  readonly hostWeight?: number;
  readonly typeFrom?: string;
  /**
   * Its rank among its neighbours (`prominence`): the targets it is never
   * drawn less prominent than, each by size, weight and how strongly its
   * words read (their contrast on their surface), the apps' targets whose
   * nodes it is never drawn smaller than (`apps`: a figure an app draws in
   * the summary could be read as the amount), and why. Its `size` is drawn
   * at least at the largest size it outranks, so no narrow box draws it
   * smaller than a row the host keeps at its own size.
   */
  readonly outranks?: { readonly why: string; readonly over: Readonly<Record<string, readonly PrivateRankBy[]>>; readonly apps?: readonly string[] };
}

/** What a rank compares: words' size, their weight, their contrast on their surface. */
export type PrivateRankBy = "size" | "weight" | "contrast";

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
  /** A repeated unit's: the page's part that draws it. */
  readonly part?: string;
  /**
   * The parts a buyer's first screen reaches (a page's): the rendered gate
   * requires one of them to start inside the first screen at every width.
   */
  readonly lead?: readonly string[];
  /**
   * Parts that come before others in reading order, whatever the
   * arrangement (`[before, after]`: the cart's notices before its details,
   * so a cart-wide alert is read before the form on a phone).
   */
  readonly order?: ReadonlyArray<readonly [string, string]>;
}

/**
 * A host label a theme may change. Words that name an action or an amount
 * (go back, confirm, check out, subtotal) are chosen from the host's
 * variants (`variants`), each translated by core in the store's copy, so a
 * theme can never make "Go back" confirm or a subtotal read as the total.
 * Words that describe (a heading, a title, an empty state) are the theme's
 * own plain text, per language, up to `max` characters, with no figures (no
 * digit and no currency sign in any script), so a label never reads as an
 * amount; only a sentence (`figures: true`: the cart's intro, its empty
 * text) may hold one.
 */
export type PrivateLabelSpec =
  | { readonly max: number; readonly figures?: true; readonly variants?: undefined }
  | { readonly variants: readonly [string, ...string[]]; readonly max?: undefined; readonly figures?: undefined };

export interface PrivatePageSpec extends PrivateUnitSpec {
  /** The elements a theme styles by tokens, by name (`page` is the page itself). */
  readonly styles: Readonly<Record<string, PrivateStyleSpec>>;
  /** The `data-private` value of its root (the stylesheet's scope). */
  readonly root: string;
  /** The page frame's closed variants, the first the default. */
  readonly frames?: readonly [string, ...string[]];
  /** The hooks a host layout draws inside itself (the fold's bar and body). */
  readonly layoutHooks?: Partial<Record<PrivateLayoutKind, readonly string[]>>;
  /** What a host layout may hold (parts and targets by name; plain layouts always). */
  readonly layoutContents?: Partial<Record<PrivateLayoutKind, readonly string[]>>;
  /** Repeated units, by name. */
  readonly items: Readonly<Record<string, PrivateUnitSpec>>;
  /** Host labels the theme may change: a host variant for an action or an amount, its own words for the rest. */
  readonly labels: Readonly<Record<string, PrivateLabelSpec>>;
  /** Host icons the theme may replace with its own image. */
  readonly icons: readonly string[];
}

const part = (mandatory: boolean, hooks: readonly string[], fields?: "fields" | null, variants?: readonly [string, ...string[]]): PrivatePartSpec => ({ mandatory, hooks, ...(fields ? { fields: true } : {}), ...(variants ? { variants } : {}) });
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
  inputs: part(true, ["line-inputs"], "fields"),
  quantity: part(true, ["line-quantity"]),
  price: part(true, ["line-price"]),
  remove: part(true, ["line-remove"]),
  limit: part(true, ["line-limit"]),
  issue: part(true, ["line-issue"]),
  rule: part(true, ["line-rule"]),
} as const satisfies Record<string, PrivatePartSpec>;

/**
 * The cart page's line: the shared parts, with the cart's own variants. Its
 * details as labelled lines (`lines`), as the chosen values only, on one line
 * where they fit (`values`, "Rockstar Launcher / Account") or as a chip per fact (`chips`,
 * `line-chip`); its remove as the × button (`icon`) or the word (`words`),
 * both 44px to tap. The drawer draws its lines as the public pages do.
 */
const CART_PAGE_LINE_PARTS = {
  ...CART_LINE_PARTS,
  details: part(true, ["line-details", "line-chip"], null, ["lines", "values", "chips"]),
  inputs: part(true, ["line-inputs", "field-label"], "fields"),
  remove: part(true, ["line-remove"], null, ["icon", "words"]),
} as const satisfies Record<string, PrivatePartSpec>;

/** The line's own hook (its root). */
export const PRIVATE_LINE_HOOK = "line";

const TEXT_TOKENS = ["text", "font", "weight", "size", "leading", "case", "tracking"] as const satisfies readonly PrivateTokenName[];
const BOX_TOKENS = ["background", "gradient", "text", "muted", "link", "error", "border", "border-width", "border-style", "radius", "shadow", "padding"] as const satisfies readonly PrivateTokenName[];
const BUTTON_TOKENS = ["background", "gradient", "text", "border", "border-width", "border-style", "radius", "shadow", "ring", "inset", "font", "weight", "size", "case", "tracking"] as const satisfies readonly PrivateTokenName[];
const FIELD_TOKENS = ["background", "text", "placeholder", "border", "ring", "invalid", "border-width", "radius"] as const satisfies readonly PrivateTokenName[];

/**
 * The fields the host draws (a check box or a radio is drawn by its label). A field drawn as a box around its input
 * (the phone number with its country code: `data-field`) is that box: its edge and fill are the field's, and the
 * input inside it draws none of its own, so the edge the check reads is the edge a buyer sees.
 */
const FIELD_ELEMENTS = ':is(input:not([type="checkbox"],[type="radio"],[type="hidden"]):not([data-field] *),select:not([data-field] *),textarea:not([data-field] *),[data-field])';

/** The cart page's style targets (and the store's dialogs over it), outer before inner. */
const CART_STYLES: Record<string, PrivateStyleSpec> = {
  // The page's paint (F2: a gradient behind everything) and its frame's width.
  page: { selector: "body[data-private-body]", absolute: true, tokens: ["background", "gradient", "text", "muted", "link", "error"], kind: "box", surface: "background", ink: "foreground" },
  frame: { selector: "", tokens: ["max-width"], kind: "box", surface: "under", ink: "foreground", on: "page" },
  // Every filled button the host draws without a target of its own (bg-primary), and every field, on the page and in its dialogs.
  action: { selector: ':is([data-private="cart"],[data-private="dialog"]) .bg-primary', absolute: true, tokens: [...BUTTON_TOKENS], kind: "control", surface: "primary", ink: "primary-foreground", hostSize: 14, hostWeight: 600 },
  input: { selector: `:is([data-private="cart"],[data-private="dialog"]) ${FIELD_ELEMENTS}`, absolute: true, element: FIELD_ELEMENTS, tokens: [...FIELD_TOKENS], kind: "field", surface: "background", ink: "foreground" },
  // Every field's label (and a group of fields' legend), wherever fields are drawn: on the box that holds them.
  "field-label": { selector: ':is([data-private="cart"],[data-private="dialog"]) [data-part="field-label"]', absolute: true, element: '[data-part="field-label"]', tokens: ["text", "size", "weight", "case", "tracking"], kind: "text", surface: "under", ink: "foreground" },
  notice: { selector: '[data-part="notice"]', tokens: ["background", "text", "muted", "link", "error", "border", "border-width", "radius"], kind: "box", surface: "under", ink: "foreground", part: "notices" },
  lines: { selector: '[data-part="lines"]', tokens: [...BOX_TOKENS], kind: "box", surface: "card", ink: "foreground", part: "lines" },
  // The heading and the theme's intro under it: in the card, or (`heading-above`) on what the card stands on.
  "lines-heading": { selector: '[data-part="lines-heading"]', tokens: [...TEXT_TOKENS], kind: "text", surface: "under", ink: "foreground", on: "lines", outside: ["heading-above"] },
  "lines-intro": { selector: '[data-part="lines-intro"]', tokens: ["text", "size", "weight", "leading"], kind: "text", surface: "under", ink: "muted-foreground", on: "lines", outside: ["heading-above"] },
  "cart-empty": { selector: '[data-part="cart-empty"]', tokens: ["text", "muted"], kind: "text", surface: "under", ink: "foreground", on: "lines" },
  line: { selector: '[data-part="line"]', tokens: ["background", "border", "border-width", "border-style", "radius", "padding"], kind: "box", surface: "under", ink: "foreground", on: "lines" },
  "line-image": { selector: '[data-part="line-image"]', tokens: ["width", "height", "width-wide", "height-wide", "radius", "background", "border", "border-width", "border-style", "fit"], kind: "text", surface: "muted", ink: "foreground", item: "line", part: "image" },
  "line-title": { selector: '[data-part="line-title"]', tokens: [...TEXT_TOKENS, "clamp"], kind: "text", surface: "under", ink: "foreground", item: "line", part: "title" },
  "line-details": { selector: '[data-part="line-details"]', tokens: ["text", "size"], kind: "text", surface: "under", ink: "muted-foreground", item: "line", part: "details" },
  // A fact of the line as a chip (`chips`): words on a surface of its own, like an app's badge.
  "line-chip": { selector: '[data-part="line-chip"]', tokens: ["background", "text", "border", "border-width", "radius"], kind: "text", surface: "under", ink: "foreground", on: "line-details" },
  "line-price": { selector: '[data-part="line-price"]', tokens: ["text", "muted", "font", "weight", "size", "align"], kind: "text", surface: "under", ink: "foreground", item: "line", part: "price" },
  "line-quantity": { selector: '[data-part="line-quantity"]', tokens: ["background", "text", "border", "border-width", "border-style", "radius", "ring"], kind: "control", surface: "under", ink: "foreground", item: "line", part: "quantity", boundary: "edge" },
  "line-remove": { selector: '[data-part="line-remove"]', tokens: ["text", "size", "weight", "radius", "ring"], kind: "control", surface: "under", ink: "muted-foreground", item: "line", part: "remove" },
  "fold-toggle": { selector: '[data-part="fold-toggle"]', tokens: ["background", "text", "border", "border-width", "radius", "shadow", "ring"], kind: "control", surface: "card", ink: "foreground", layout: "fold", boundary: "edge" },
  summary: { selector: '[data-part="summary"]', tokens: [...BOX_TOKENS, "gap"], kind: "box", surface: "card", ink: "foreground", part: "summary" },
  "summary-heading": { selector: '[data-part="summary-heading"]', tokens: [...TEXT_TOKENS], kind: "text", surface: "under", ink: "foreground", on: "summary" },
  // Every money row but the total (items, subtotal, add-ons, delivery, discount, tax): never drawn larger than the total.
  "summary-rows": { selector: '[data-summary-row]:not([data-summary-row="total"])', tokens: ["text", "size"], kind: "text", surface: "under", ink: "muted-foreground", on: "summary", hostSize: 14, hostWeight: 500 },
  // The total's amount (and, unless its label sets its own, its label): it outranks every other money row, the
  // add-on's lines and its own label, so no theme makes a subtotal read as the total.
  "summary-total": {
    selector: '[data-summary-row="total"]', tokens: [...TEXT_TOKENS], kind: "text", surface: "under", ink: "foreground", on: "summary", hostSize: 20, hostWeight: 600,
    outranks: { why: "the total reads at least as strongly as every other amount, so a buyer never takes a subtotal for it", over: { "summary-rows": ["size", "weight", "contrast"], "summary-add-on-detail": ["size"], "summary-total-label": ["size"], "line-price": ["size"] }, apps: ["cart.page.summary"] },
  },
  // The total's label, apart from its amount; only the total row's (a label inside it), never another row's.
  "summary-total-label": {
    selector: '[data-summary-row="total"] [data-part="summary-total-label"]', tokens: [...TEXT_TOKENS], kind: "text", surface: "under", ink: "foreground", on: "summary-total", hostSize: 14, hostWeight: 600, typeFrom: "summary-total",
    outranks: { why: "the total's label is never smaller than the rows it closes", over: { "summary-rows": ["size"] } },
  },
  // An add-on row that opens to the app's lines (a money row: it stands in the row's element): its bar is a control
  // (a focus ring on the summary), each line under it a box.
  "summary-add-on": { selector: '[data-part="add-on-details"] > summary', tokens: ["text", "ring", "radius"], kind: "control", surface: "under", ink: "muted-foreground", on: "summary-rows" },
  "summary-add-on-detail": { selector: '[data-part="add-on-details"] [data-part="add-on-detail"]', tokens: ["background", "text", "muted", "border", "border-width", "radius", "padding", "font", "size"], kind: "box", surface: "under", ink: "foreground", on: "summary-rows", hostSize: 14 },
  "details-form": { selector: '[data-part="details-form"]', tokens: [...BOX_TOKENS], kind: "box", surface: "card", ink: "foreground", part: "details", targets: ["checkout.contact.after", "checkout.delivery.after"] },
  "section-heading": { selector: ':is([data-part="contact"],[data-part="delivery"]) h2', tokens: [...TEXT_TOKENS], kind: "text", surface: "under", ink: "foreground", on: "details-form" },
  // Place order with its total, the agreement and why it may be off: the page's last box, docked at the bottom
  // edge whenever its place is not in view (`position: sticky`), at every width, under every arrangement. It
  // stands over whatever scrolls beneath it, so it always paints its own surface (as a dialog does).
  dock: { selector: '[data-private="cart"] [data-part="dock"]', absolute: true, tokens: ["background", "text", "muted", "link", "error", "border", "border-width", "shadow"], kind: "box", surface: "background", ink: "foreground", on: "page" },
  submit: {
    selector: '[data-part="details-submit"]', tokens: [...BUTTON_TOKENS], kind: "control", surface: "primary", ink: "primary-foreground", on: "dock", boundary: "fill", hostSize: 16, hostWeight: 600, typeFrom: "action",
    outranks: { why: "Place order is the page's one filled action: never smaller or lighter than the store's other filled buttons", over: { action: ["size", "weight"] } },
  },
  legal: { selector: '[data-part="legal"]', tokens: ["text", "size", "align"], kind: "text", surface: "under", ink: "muted-foreground", on: "dock" },
  // The store's dialogs over the page (confirmation, sign-in): their surface, words, fields and buttons.
  dialog: { selector: '[data-private="dialog"]', absolute: true, tokens: ["background", "text", "muted", "link", "error", "border", "border-width", "radius", "shadow"], kind: "box", surface: "card", ink: "foreground", on: "page", fields: true },
  "dialog-title": { selector: '[data-private="dialog"] [data-part="dialog-title"]', absolute: true, tokens: [...TEXT_TOKENS], kind: "text", surface: "under", ink: "foreground", on: "dialog" },
  // What the buyer agrees to, and the tick box saying so: boxes side by side in the dialog, neither inside the other.
  "dialog-text": { selector: '[data-private="dialog"] [data-part="dialog-text"]', absolute: true, tokens: ["background", "text", "muted", "border", "border-width", "radius", "padding"], kind: "box", surface: "under", ink: "foreground", on: "dialog" },
  "dialog-agree": { selector: '[data-private="dialog"] [data-part="dialog-agree"]', absolute: true, tokens: ["background", "text", "border", "border-width", "radius", "padding"], kind: "box", surface: "under", ink: "foreground", on: "dialog" },
  // The decision's two buttons never swap looks: Go back is outlined, never filled (no surface of its own); Confirm
  // is filled, its fill read at 3:1 on the dialog, and never smaller or lighter than Go back.
  "dialog-back": { selector: '[data-private="dialog"] [data-part="dialog-back"]', absolute: true, tokens: ["text", "border", "border-width", "radius", "ring", "inset", "weight"], kind: "control", surface: "under", ink: "foreground", on: "dialog", boundary: "edge", hostSize: 14, hostWeight: 500 },
  "dialog-confirm": {
    selector: '[data-private="dialog"] [data-part="dialog-confirm"]', absolute: true, tokens: [...BUTTON_TOKENS], kind: "control", surface: "primary", ink: "primary-foreground", on: "dialog", boundary: "fill", hostSize: 14, hostWeight: 500, typeFrom: "action",
    outranks: { why: "Confirm is the decision's filled action: never smaller or lighter than Go back", over: { "dialog-back": ["size", "weight"] } },
  },
  // The store's own chrome: its checkout header, and the strip at the page's end that holds the store's controls
  // when the theme places them there (`privatePages.controls: footer`). Their surface, words and border.
  chrome: { selector: ':is([data-private="core-header"],[data-private="core-footer"])', absolute: true, tokens: ["background", "gradient", "text", "muted", "link", "border", "border-width"], kind: "box", surface: "background", ink: "foreground", on: "page" },
  // The store's controls in its chrome, where the theme places them (`privatePages.controls`): the light or
  // dark switch and the market and language forms.
  scheme: { selector: '[data-host="scheme"] button', absolute: true, tokens: ["text", "ring", "radius"], kind: "control", surface: "under", ink: "foreground", on: "chrome" },
  localization: { selector: '[data-host="localization"]', absolute: true, tokens: ["text", "muted", "link"], kind: "box", surface: "under", ink: "foreground", on: "chrome", fields: true },
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
    // Its heading (with the theme's intro under it and the way back to the store) inside the card (`heading-inside`),
    // or above it on what the card stands on, in `lines-header` (`heading-above`).
    lines: part(true, ["lines", "lines-header", "lines-heading", "lines-intro", "lines-continue", "lines-loading", "lines-list", "lines-clear", "lines-undo", "cart-empty", "cart-empty-icon"], null, ["heading-inside", "heading-above"]),
    // Its money rows carry `data-summary-row` (items, subtotal, add-on, delivery, discount, tax, total), as on every surface;
    // the theme's heading over them (`summary-heading`, only when set), an Items row first (`with-items`), the total's
    // label apart from its amount (`summary-total-label`); an add-on row with the app's lines under it opens to them
    // (`add-on-details`, a disclosure the host draws, one `add-on-detail` per line).
    summary: part(true, ["summary", "summary-heading", "summary-validation", "summary-total-label", "add-on-details", "add-on-detail"], null, ["totals", "with-items"]),
    discount: part(false, ["discount"], "fields"),
    details: part(true, ["details", "details-sign-in", "details-form", "contact", "delivery", "field-label", "details-errors", "dock", "details-submit", "legal"], "fields"),
    empty: part(false, ["empty-extras"]),
  },
  targets: ["cart.page.summary", "cart.page.below"],
  lead: ["lines", "summary", "details"],
  order: [["notices", "details"]],
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
      part: "lines",
      parts: CART_PAGE_LINE_PARTS,
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
    // One sentence under the heading; the summary's heading, drawn only when set, among the amounts: words only.
    "cart.intro": { max: 200, figures: true },
    "cart.summaryHeading": { max: 40 },
    "cart.continue": { variants: ["continue-shopping", "keep-shopping", "back-to-store"] },
    "cart.empty": { max: 80 },
    "cart.emptyText": { max: 200, figures: true },
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
    summary: part(true, ["drawer-summary", "drawer-total", "drawer-blocked", "add-on-details", "add-on-detail"]),
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
      part: "lines",
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
/** A layout node's theme hook (`data-hook="<name>"`), the name its tokens take (`@<hook>`). */
export const PRIVATE_HOOK_ATTRIBUTE = "data-hook";
/** A theme hook: lowercase words joined by hyphens (`studio-summary`). */
export const PRIVATE_HOOK_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+){0,5}$/;
export const PRIVATE_HOOK_MAX = 40;

/** Surfaces besides the pages that carry the scope: the store's dialogs and its own chrome there. */
export const PRIVATE_SCOPES = ["dialog", "core-header", "core-footer"] as const;

/**
 * Where the store's controls sit on a private page (`privatePages.controls`):
 * the light or dark switch (where the theme offers it) and the market and
 * language forms (where the store sells in several), in the store's checkout
 * header (`header`, unset), in a strip at the page's end (`footer`), or not at
 * all (`none`). Each is a host part, its look the `scheme` and `localization`
 * targets' tokens on the `chrome` row.
 */
export const PRIVATE_CONTROL_PLACES = ["header", "footer", "none"] as const;
export type PrivateControlPlace = (typeof PRIVATE_CONTROL_PLACES)[number];

/**
 * The store's dialogs over a private page (`data-private="dialog"`): the
 * confirmation an app's choice asks for, and sign-in (`sign-in`).
 */
export const PRIVATE_DIALOG_HOOKS = ["sign-in", "dialog-title", "dialog-text", "dialog-agree", "dialog-actions", "dialog-back", "dialog-confirm", "field-label"] as const;

/**
 * An app's buyer UI block, wherever a private page draws it: its mount's
 * `data-buyer-ui-target`, the block's wrapper with `data-buyer-ui-app` (the
 * app's id) and each node's kind on `data-ui` (`banner`, `text`, `button`,
 * …) and tone on `data-tone`.
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
    const fields = Object.entries(spec.parts).filter(([, entry]) => entry.fields).map(([name]) => name);
    if (fields.length > 0) lines.push(`${prefix} fields in ${fields.join(",")}`);
    for (const target of spec.targets) lines.push(`${prefix} target ${target}`);
    for (const [before, after] of spec.order ?? []) lines.push(`${prefix} order ${before} before ${after}`);
    if (spec.lead) lines.push(`${prefix} lead ${spec.lead.join(",")}`);
    lines.push(`${prefix} layouts ${spec.layouts.join(",")}`);
  };
  for (const page of PRIVATE_PAGE_KEYS) {
    const spec: PrivatePageSpec = PRIVATE_PAGES[page];
    lines.push(`${page} root ${PRIVATE_SCOPE_ATTRIBUTE}=${spec.root}${spec.frames ? ` frames=${spec.frames.join("|")}` : ""}`);
    unit(page, spec);
    for (const [kind, hooks] of Object.entries(spec.layoutHooks ?? {})) lines.push(`${page} layout ${kind} hooks=${hooks.join(",")}`);
    for (const [kind, names] of Object.entries(spec.layoutContents ?? {})) lines.push(`${page} layout ${kind} holds=${names.join(",")}`);
    for (const [name, style] of Object.entries(spec.styles)) lines.push(`${page} style ${name} ${style.absolute ? "" : "<root> "}${style.selector || "<root>"} tokens=${style.tokens.join(",")}${style.fields ? " fields" : ""}${style.targets ? ` targets=${style.targets.join(",")}` : ""}${style.outside ? ` outside-when=${style.outside.join("|")}` : ""}${style.boundary ? ` boundary=${style.boundary}` : ""}${style.outranks ? ` outranks=${[...Object.entries(style.outranks.over).map(([other, by]) => `${other}:${by.join("+")}`), ...(style.outranks.apps ?? []).map((target) => `ui/${target}:size`)].join(",")}` : ""}`);
    for (const [name, item] of Object.entries(spec.items)) {
      lines.push(`${page}.${name} root ${PRIVATE_PART_ATTRIBUTE}=${PRIVATE_LINE_HOOK}`);
      unit(`${page}.${name}`, item);
    }
    for (const [key, label] of Object.entries(spec.labels)) lines.push(`${page} label ${key} ${label.variants ? `variants=${label.variants.join("|")}` : `max=${label.max}${label.figures === true ? "" : " no-figures"}`}`);
    for (const icon of spec.icons) lines.push(`${page} icon ${icon}`);
  }
  lines.push(`dialog root ${PRIVATE_SCOPE_ATTRIBUTE}=dialog hooks=${PRIVATE_DIALOG_HOOKS.join(",")}`);
  lines.push(`buyer-ui attributes=${PRIVATE_BUYER_UI_HOOKS.join(",")}`);
  lines.push(`chrome roots ${PRIVATE_SCOPE_ATTRIBUTE}=core-header|core-footer controls=${PRIVATE_CONTROL_PLACES.join("|")}`);
  lines.push(`layout tokens=${PRIVATE_LAYOUT_TOKENS.join(",")}`);
  for (const [kind, style] of Object.entries(PRIVATE_BUYER_UI_STYLES)) lines.push(`buyer-ui style ui.${kind}${style.tones ? `[.${style.tones.join("|")}]` : ""}[@<app>][/<target>] ${style.kind} tokens=${style.tokens.join(",")}`);
  return lines;
}
