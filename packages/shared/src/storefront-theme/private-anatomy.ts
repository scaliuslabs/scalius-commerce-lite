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
// parts, targets, layouts, default layout, items and style targets; its
// labels and icons in private-keys.ts) and add it to `PRIVATE_PAGES`. Its
// default layout must hold every mandatory part and target exactly once. Nothing else is per page.


export {
  PRIVATE_ANATOMY_VERSION,
  PRIVATE_CONTROL_PLACES,
  PRIVATE_HOOK_MAX,
  PRIVATE_LAYOUT_KINDS,
  PRIVATE_PAGE_KEYS,
  PRIVATE_PAGE_ROUTES,
  PRIVATE_STORE_LOOK_ROUTES,
  PRIVATE_UNTHEMED_ROUTES,
  privateIconKeys,
  privateLabelKeys,
  privateLabelVariants,
  privatePageOfPath,
  privatePageOfRoute,
  privatePageRouteLines,
  type PrivateControlPlace,
  type PrivateLabelSpec,
  type PrivateLayoutKind,
  type PrivatePageKey,
} from "./private-keys";
import { PRIVATE_CONTROL_PLACES, PRIVATE_PAGE_KEYS, PRIVATE_PAGE_WORDS, type PrivateLabelSpec, type PrivateLayoutKind, type PrivatePageKey } from "./private-keys";

export { PRIVATE_UI_TONES, PRIVATE_BUYER_UI_STYLES, type PrivateUiTone, type PrivateBuyerUiStyle } from "./private-buyer-ui";
import { PRIVATE_BUYER_UI_STYLES } from "./private-buyer-ui";
import { PRIVATE_TAB_BAR_BOUNDS, PRIVATE_TAB_BAR_CHOICES } from "./private-tab-bar-limits";

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
  // The phone tab bar's own (private-tab-bar.ts): a blurred or solid bar, the current tab's ring.
  "backdrop", "ring-width",
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
  /**
   * Its default surface: a palette role, `under` (none of its own: the surface of the row it sits in shows), or one
   * taken from the row it sits in, so a page the theme paints stays one look: `under-hover` (that row's hover surface,
   * a step from its surface its words read on) or `under-link` (that row's link colour).
   */
  readonly surface: PrivatePaletteRole | "under" | "under-hover" | "under-link";
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
   * 1.4.11, 3:1 on what is around it): `fill`, the page's main action (Place
   * order, Confirm, Pay: a buyer who cannot find it cannot buy), by its own
   * surface, or by a drawn edge where the theme sets a
   * solid border of at least 2px that reads 3:1 on what is around it over a
   * fill still clearly a colour of its own (CIE76 40 from every point around
   * it: an outlined button is Go back's look); `edge`, an outlined one (a stepper, the
   * fold's bar, Go back) and every field, by its border, or by its own
   * surface where the theme draws no border (`border-width: 0`,
   * `border-style: none`).
   */
  readonly boundary?: "fill" | "edge";
  /**
   * A box of words only (a message, an add-on's lines, what a buyer agrees to): it never holds one of the store's
   * controls, so a filled button or a focus ring drawn anywhere (`action`) is not checked on it.
   */
  readonly bare?: true;
  /**
   * The boxes it is drawn in, wherever the page draws it (a rating in a card or under an order's line): a row in each,
   * its colours read on that box, the innermost written last.
   */
  readonly within?: readonly string[];
  /**
   * Its words are a graphic's marks (a rating's stars): its own colour (`text`, the filled stars) and its muted
   * colour (`muted`, the empty ones) read at 3:1 (WCAG 1.4.11) on its surface. With no token its colour is the store's
   * rating amber where that reads, else the amber taken toward the page's words until it does.
   */
  readonly graphic?: true;
  /**
   * A choice drawn on it marks the chosen option with its link colour (its edge, its dot) where the others draw its
   * border colour: the two are clearly apart (3:1, or CIE76 40), as on the payment step.
   */
  readonly chosen?: true;
  /**
   * It may stand over the page in the top layer (an edit dialog is a card shown as a popover): it always paints its own
   * surface, even where the box it sits in paints the same, since what is beneath it there is the dialog's backdrop.
   */
  readonly opaque?: true;
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
 * The fields the host draws (a check box or a radio is drawn by its label; a file input by its button, an outlined button
 * found by its words). A field drawn as a box around its input
 * (the phone number with its country code: `data-field`) is that box: its edge and fill are the field's, and the
 * input inside it draws none of its own, so the edge the check reads is the edge a buyer sees.
 */
const FIELD_ELEMENTS = ':is(input:not([type="checkbox"],[type="radio"],[type="hidden"],[type="file"]):not([data-field] *),select:not([data-field] *),textarea:not([data-field] *),[data-field])';

/**
 * The targets every page with a page of its own takes, scoped to its root
 * (`root`), in two runs the page's own targets go between (outer before
 * inner): `head`, the page's paint and frame, every filled button and field
 * drawn on it and its notices; `tail`, the store's dialogs over it (`dialogs`:
 * the pages that open them) and the store's chrome with its controls (unless
 * `chrome: false`: a page that keeps the public header and footer). A thing
 * that is the same on every page has one name on every page.
 */
export function privatePageStyles(root: string, options: { dialogs?: boolean; chrome?: boolean } = {}): { head: Record<string, PrivateStyleSpec>; tail: Record<string, PrivateStyleSpec> } {
  const scope = options.dialogs ? `:is([data-private="${root}"],[data-private="dialog"])` : `[data-private="${root}"]`;
  const head: Record<string, PrivateStyleSpec> = {
    // The page's paint (F2: a gradient behind everything) and its frame's width.
    page: { selector: "body[data-private-body]", absolute: true, tokens: ["background", "gradient", "text", "muted", "link", "error"], kind: "box", surface: "background", ink: "foreground" },
    frame: { selector: "", tokens: ["max-width"], kind: "box", surface: "under", ink: "foreground", on: "page" },
    // Every filled button or link the host draws without a target of its own (bg-primary, never another element filled with
    // the action colour), and every field, on the page and in its dialogs. An ordinary button is found by its words (they
    // read 4.5:1 on its fill); only the main action's fill is checked against what is around it (`boundary: "fill"`).
    action: { selector: `${scope} .bg-primary:is(button,a,[role="button"])`, absolute: true, tokens: [...BUTTON_TOKENS], kind: "control", surface: "primary", ink: "primary-foreground", hostSize: 14, hostWeight: 600 },
    input: { selector: `${scope} ${FIELD_ELEMENTS}`, absolute: true, element: FIELD_ELEMENTS, tokens: [...FIELD_TOKENS], kind: "field", surface: "background", ink: "foreground" },
    // Every field's label (and a group of fields' legend), wherever fields are drawn: on the box that holds them.
    "field-label": { selector: `${scope} [data-part="field-label"]`, absolute: true, element: '[data-part="field-label"]', tokens: ["text", "size", "weight", "case", "tracking"], kind: "text", surface: "under", ink: "foreground" },
    notice: { selector: '[data-part="notice"]', tokens: ["background", "text", "muted", "link", "error", "border", "border-width", "radius"], kind: "box", surface: "under", ink: "foreground", part: "notices" },
  };
  const tail: Record<string, PrivateStyleSpec> = options.dialogs ? {
    // The store's dialogs over the page (confirmation, sign-in): their surface, words, fields and buttons.
    dialog: { selector: '[data-private="dialog"]', absolute: true, tokens: ["background", "text", "muted", "link", "error", "border", "border-width", "radius", "shadow"], kind: "box", surface: "card", ink: "foreground", on: "page", fields: true },
    "dialog-title": { selector: '[data-private="dialog"] [data-part="dialog-title"]', absolute: true, tokens: [...TEXT_TOKENS], kind: "text", surface: "under", ink: "foreground", on: "dialog" },
    // What the buyer agrees to, and the tick box saying so: boxes side by side in the dialog, neither inside the other.
    "dialog-text": { selector: '[data-private="dialog"] [data-part="dialog-text"]', absolute: true, tokens: ["background", "text", "muted", "border", "border-width", "radius", "padding"], kind: "box", surface: "under", ink: "foreground", on: "dialog", bare: true },
    "dialog-agree": { selector: '[data-private="dialog"] [data-part="dialog-agree"]', absolute: true, tokens: ["background", "text", "border", "border-width", "radius", "padding"], kind: "box", surface: "under", ink: "foreground", on: "dialog" },
    // The decision's two buttons never swap looks: Go back is outlined, never filled (no surface of its own); Confirm
    // is filled, its fill read at 3:1 on the dialog, and never smaller or lighter than Go back.
    "dialog-back": { selector: '[data-private="dialog"] [data-part="dialog-back"]', absolute: true, tokens: ["text", "border", "border-width", "radius", "ring", "inset", "weight"], kind: "control", surface: "under", ink: "foreground", on: "dialog", boundary: "edge", hostSize: 14, hostWeight: 500 },
    "dialog-confirm": {
      selector: '[data-private="dialog"] [data-part="dialog-confirm"]', absolute: true, tokens: [...BUTTON_TOKENS], kind: "control", surface: "primary", ink: "primary-foreground", on: "dialog", boundary: "fill", hostSize: 14, hostWeight: 500, typeFrom: "action",
      outranks: { why: "Confirm is the decision's filled action: never smaller or lighter than Go back", over: { "dialog-back": ["size", "weight"] } },
    },
  } : {};
  if (options.chrome === false) return { head, tail };
  Object.assign(tail, {
    // The store's own chrome: its checkout header, and the strip at the page's end that holds the store's controls
    // when the theme places them there (`privatePages.controls: footer`). Their surface, words and border.
    chrome: { selector: ':is([data-private="core-header"],[data-private="core-footer"])', absolute: true, tokens: ["background", "gradient", "text", "muted", "link", "border", "border-width"], kind: "box", surface: "background", ink: "foreground", on: "page" },
    // The store's controls in its chrome, where the theme places them (`privatePages.controls`): the light or
    // dark switch and the market and language forms.
    scheme: { selector: '[data-host="scheme"] button', absolute: true, tokens: ["text", "ring", "radius"], kind: "control", surface: "under", ink: "foreground", on: "chrome" },
    localization: { selector: '[data-host="localization"]', absolute: true, tokens: ["text", "muted", "link"], kind: "box", surface: "under", ink: "foreground", on: "chrome", fields: true },
  } satisfies Record<string, PrivateStyleSpec>);
  return { head, tail };
}

/**
 * A money summary's targets, the same on every page that lists the order's
 * money: the box (`part`, or `on` a target that holds it), its heading, every
 * row but the total, the total and its label, and an add-on row that opens to
 * the app's lines. The sizes and weights (px, CSS weight) are what the page
 * draws with no token; `due` adds the rows that say what is left to pay (a gift
 * card's, a deposit's) to the total's target, so they rank with it; `over`
 * adds the page's other amounts the total outranks (a cart line's price) and
 * `apps` the apps' targets drawn among the amounts, whose nodes it is never
 * drawn smaller than.
 */
export function privateSummaryStyles(options: {
  part?: string; on?: string; due?: boolean;
  rows: { size: number; weight: number }; total: { size: number; weight: number }; label: { size: number; weight: number };
  over?: Readonly<Record<string, readonly PrivateRankBy[]>>; apps?: readonly string[];
}): Record<string, PrivateStyleSpec> {
  const total = options.due ? ':is([data-summary-row="total"],[data-summary-row="due"])' : '[data-summary-row="total"]';
  return {
    summary: { selector: '[data-part="summary"]', tokens: [...BOX_TOKENS, "gap"], kind: "box", surface: "card", ink: "foreground", ...(options.on ? { on: options.on } : { part: options.part ?? "summary" }) },
    "summary-heading": { selector: '[data-part="summary-heading"]', tokens: [...TEXT_TOKENS], kind: "text", surface: "under", ink: "foreground", on: "summary" },
    // Every money row but the total (items, subtotal, add-ons, delivery, discount, tax): never drawn larger than the total.
    "summary-rows": { selector: `[data-summary-row]:not(${total})`, tokens: ["text", "size"], kind: "text", surface: "under", ink: "muted-foreground", on: "summary", hostSize: options.rows.size, hostWeight: options.rows.weight },
    // The total's amount (and, unless its label sets its own, its label): it outranks every other money row, the
    // add-on's lines and its own label, so no theme makes a subtotal read as the total.
    "summary-total": {
      selector: total, tokens: [...TEXT_TOKENS], kind: "text", surface: "under", ink: "foreground", on: "summary", hostSize: options.total.size, hostWeight: options.total.weight,
      outranks: { why: "the total reads at least as strongly as every other amount, so a buyer never takes a subtotal for it", over: { "summary-rows": ["size", "weight", "contrast"], "summary-add-on-detail": ["size"], "summary-total-label": ["size"], ...options.over }, ...(options.apps ? { apps: options.apps } : {}) },
    },
    // The total's label, apart from its amount; only the total row's (a label inside it), never another row's.
    "summary-total-label": {
      selector: `${total} [data-part="summary-total-label"]`, tokens: [...TEXT_TOKENS], kind: "text", surface: "under", ink: "foreground", on: "summary-total", hostSize: options.label.size, hostWeight: options.label.weight, typeFrom: "summary-total",
      outranks: { why: "the total's label is never smaller than the rows it closes", over: { "summary-rows": ["size"] } },
    },
    // An add-on row that opens to the app's lines (a money row: it stands in the row's element): its bar is a control
    // (a focus ring on the summary), each line under it a box.
    "summary-add-on": { selector: '[data-part="add-on-details"] > summary', tokens: ["text", "ring", "radius"], kind: "control", surface: "under", ink: "muted-foreground", on: "summary-rows" },
    "summary-add-on-detail": { selector: '[data-part="add-on-details"] [data-part="add-on-detail"]', tokens: ["background", "text", "muted", "border", "border-width", "radius", "padding", "font", "size"], kind: "box", surface: "under", ink: "foreground", on: "summary-rows", hostSize: 14, bare: true },
  };
}

/**
 * A page's styles with `action` (every filled button the host draws without a target of its own) never reaching a
 * filled action that has its own row (`boundary: "fill"`: Place order, Confirm, Pay): two rows on one element would
 * draw over what the check reads. Built from those rows' selectors, so a page that adds one is kept apart too.
 */
function actionApart(root: string, styles: Record<string, PrivateStyleSpec>): Record<string, PrivateStyleSpec> {
  const action = styles.action;
  if (!action) return styles;
  const own = Object.entries(styles).filter(([key, style]) => key !== "action" && style.boundary === "fill")
    .map(([, style]) => style.absolute ? style.selector : `[data-private="${root}"] ${style.selector}`);
  return own.length === 0 ? styles : { ...styles, action: { ...action, selector: `${action.selector}:not(${own.join(",")})` } };
}

const CART_PAGE_STYLES = privatePageStyles("cart", { dialogs: true });

/** The cart page's style targets (and the store's dialogs over it), outer before inner. */
const CART_STYLES: Record<string, PrivateStyleSpec> = {
  ...CART_PAGE_STYLES.head,
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
  ...privateSummaryStyles({ rows: { size: 14, weight: 500 }, total: { size: 20, weight: 600 }, label: { size: 14, weight: 600 }, over: { "line-price": ["size"] }, apps: ["cart.page.summary"] }),
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
  ...CART_PAGE_STYLES.tail,
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
  styles: actionApart("cart", CART_STYLES),
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
  ...PRIVATE_PAGE_WORDS.cart,
};

/** The cart drawer: the cart over any page, opened in the browser. */
const CART_DRAWER: PrivatePageSpec = {
  root: "cart-drawer",
  frames: ["standard", "wide"],
  layoutHooks: { scroll: ["drawer-scroll"] },
  // The scroll region holds what a buyer browses; the total and the way to check out stay in view (the summary's rows
  // and the apps' footer blocks end the scroll region: CartFlyout.tsx).
  layoutContents: { scroll: ["added", "lines", "recommendations", "undo", "offers"] },
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
  ...PRIVATE_PAGE_WORDS.cartDrawer,
};

// ─── The payment step (`checkout`) ─────────────────────────────────────────

const CHECKOUT_PAGE_STYLES = privatePageStyles("checkout");

/**
 * The payment step's style targets, outer before inner. The order summary
 * takes the cart's names (its rows, total, add-on row, phone bar), Pay takes
 * `submit` and the terms beside it `legal`. The gateway's own surface (its
 * card form, a provider's frame: `data-part="gateway"`) has no target and
 * token mode never reaches into it: no theme restyles, hides or covers it.
 */
const CHECKOUT_STYLES: Record<string, PrivateStyleSpec> = {
  ...CHECKOUT_PAGE_STYLES.head,
  // No checkout to pay for: the way back to the shop.
  "checkout-empty": { selector: '[data-part="checkout-empty"]', tokens: [...BOX_TOKENS], kind: "box", surface: "card", ink: "foreground", part: "empty" },
  heading: { selector: '[data-part="heading"]', tokens: [...TEXT_TOKENS], kind: "text", surface: "under", ink: "foreground", part: "heading" },
  ...privateSummaryStyles({ rows: { size: 14, weight: 400 }, total: { size: 14, weight: 700 }, label: { size: 14, weight: 700 }, due: true, apps: ["checkout.summary.after"] }),
  // The summary's bar that states the total and opens it (phones; every width when `folded`): the cart's fold bar.
  "fold-toggle": { selector: '[data-part="fold-toggle"]', tokens: ["background", "text", "border", "border-width", "radius", "shadow", "ring"], kind: "control", surface: "under", ink: "foreground", on: "summary", boundary: "edge" },
  "gift-card": { selector: '[data-part="gift-card"]', tokens: [...BOX_TOKENS], kind: "box", surface: "card", ink: "foreground", part: "gift-card" },
  // One payment method, and the one the buyer chose (drawn after it, so it wins where both reach).
  "payment-method": { selector: '[data-part="payment-method"]', tokens: [...BOX_TOKENS], kind: "box", surface: "card", ink: "foreground", part: "payment" },
  "payment-chosen": { selector: '[data-part="payment-method"][data-chosen]', tokens: ["background", "text", "muted", "border", "border-width", "shadow"], kind: "box", surface: "under", ink: "foreground", on: "payment-method" },
  // The chosen method's details (its notice, Pay, the terms): in its card, or (`tiles`) under the grid on what the methods stand on.
  "payment-details": { selector: '[data-part="payment-details"]', tokens: ["background", "text", "muted", "link", "error", "border", "border-width", "radius", "padding"], kind: "box", surface: "under", ink: "foreground", on: "payment-chosen", outside: ["tiles"] },
  submit: {
    selector: '[data-part="pay"]', tokens: [...BUTTON_TOKENS], kind: "control", surface: "primary", ink: "primary-foreground", on: "payment-details", boundary: "fill", hostSize: 16, hostWeight: 600, typeFrom: "action",
    outranks: { why: "Pay is the page's one filled action: never smaller or lighter than the store's other filled buttons", over: { action: ["size", "weight"] } },
  },
  legal: { selector: '[data-part="legal"]', tokens: ["text", "size", "align"], kind: "text", surface: "under", ink: "muted-foreground", on: "payment-details" },
  ...CHECKOUT_PAGE_STYLES.tail,
};

/**
 * The payment step: the order summary, the gift card, the payment methods
 * (the gateway's own surface inside them, untouched) and Pay with the terms
 * beside it. `payment` is one part: its methods, the chosen method's details,
 * Pay and the terms stay together in the store's order, whatever the theme.
 */
const CHECKOUT_PAGE: PrivatePageSpec = {
  root: "checkout",
  frames: ["standard", "narrow"],
  parts: {
    progress: part(false, ["progress"]),
    empty: part(true, ["checkout-empty"]),
    // `open-wide`: folded behind its bar on phones, open from 64rem; `folded`: behind its bar at every width.
    summary: part(true, ["summary", "fold-toggle", "summary-panel", "summary-heading", "summary-total-label", "add-on-details", "add-on-detail"], null, ["open-wide", "folded"]),
    heading: part(true, ["heading"]),
    notices: part(true, ["notice"]),
    "gift-card": part(true, ["gift-card"], "fields"),
    payment: part(true, ["payment", "payment-method", "payment-details", "gateway", "pay", "legal"], null, ["list", "tiles"]),
  },
  targets: ["checkout.payment.after", "checkout.actions.before"],
  // Why Pay may be off is read before Pay, as on the cart.
  order: [["notices", "payment"]],
  lead: ["summary", "payment"],
  layouts: ["stack", "columns", "grid", "group"],
  styles: actionApart("checkout", { ...CHECKOUT_STYLES, summary: { ...CHECKOUT_STYLES.summary!, targets: ["checkout.summary.after"] } }),
  layout: [
    p("progress"),
    p("empty"),
    l("columns", [
      l("stack", [p("summary")]),
      l("stack", [p("heading"), p("notices"), p("gift-card"), p("payment"), t("checkout.payment.after"), t("checkout.actions.before")]),
    ]),
  ],
  items: {},
  ...PRIVATE_PAGE_WORDS.checkout,
};

// ─── The receipt and the account (the pages after the order) ──────────────

/**
 * What the receipt and the account share with the cart, by the cart's names
 * (`privatePageStyles`, `privateSummaryStyles`): the page and its frame, every
 * filled button and field, the money rows and the total (the total outranks
 * every other row), and a line's image, title, facts and price. A theme gives
 * the same thing one look on every page. Both keep the public header and
 * footer (closed core variants in the palette's colours), so neither takes
 * the store's checkout chrome.
 */
const RECEIPT_PAGE_STYLES = privatePageStyles("receipt", { dialogs: true, chrome: false });
const ACCOUNT_PAGE_STYLES = privatePageStyles("account", { dialogs: true, chrome: false });
/** The page-wide targets but the notices: neither page draws the cart's notices part. */
const withoutNotices = ({ notice: _notice, ...rest }: Record<string, PrivateStyleSpec>) => rest;

/**
 * An order's line as the cart's line is styled, inside the box `on`, with the apps' `order.line.after` under it.
 * `fit` reaches an image inside its box: a page whose line image is the `<img>` itself (`imageBox: false`) does not take it.
 */
const afterOrderLineStyles = (on: string, { imageBox }: { imageBox: boolean }): Record<string, PrivateStyleSpec> => ({
  line: { ...CART_STYLES.line!, on, targets: ["order.line.after"] },
  "line-image": { ...CART_STYLES["line-image"]!, tokens: CART_STYLES["line-image"]!.tokens.filter((token) => imageBox || token !== "fit"), item: undefined, part: undefined, on: "line" },
  "line-title": { ...CART_STYLES["line-title"]!, tokens: [...TEXT_TOKENS], item: undefined, part: undefined, on: "line" },
  "line-details": { ...CART_STYLES["line-details"]!, item: undefined, part: undefined, on: "line" },
  "line-price": { ...CART_STYLES["line-price"]!, item: undefined, part: undefined, on: "line" },
});

/** An order's or a request's state as a pill: words on a surface of their own (the receipt's order and payment states, the account's in its cards). */
const statusBadge = (on: string): PrivateStyleSpec => ({ selector: '[data-part="status-badge"]', tokens: ["background", "text", "border", "border-width", "radius"], kind: "text", surface: "under", ink: "foreground", on });

/**
 * A rating's stars (a review's, under an order's line or in the account's reviews; the star picker of its form): the
 * filled stars are its `text`, the empty ones its `muted`, each read at 3:1 on the box it is drawn in.
 */
const ratingStyle = (within: readonly string[]): PrivateStyleSpec => ({ selector: '[data-part="rating"]', tokens: ["text", "muted", "size"], kind: "text", surface: "under", ink: "foreground", within, graphic: true });

/**
 * A control that starts a payment after the order (the account order's Pay, the receipt's card Pay): a main action as
 * the payment step's Pay is (`submit`, the same `[data-part="pay"]`), found by its fill at 3:1 on what is around it or
 * by a drawn edge, never `action`'s. `size` and `weight` are what the page draws with no token.
 */
const payStyle = (on: string, host: { size: number; weight: number }): PrivateStyleSpec => ({
  selector: '[data-part="pay"]', tokens: [...BUTTON_TOKENS], kind: "control", surface: "primary", ink: "primary-foreground", on, boundary: "fill", hostSize: host.size, hostWeight: host.weight, typeFrom: "action",
});

/** A message's tokens: a box of words (its photos and product cards inside), never a gradient or a shadow. */
const MESSAGE_TOKENS = ["background", "text", "muted", "link", "error", "border", "border-width", "radius", "padding"] as const satisfies readonly PrivateTokenName[];

/**
 * A conversation with the store, the same on every page that draws one (the receipt's, the account's order page and
 * inbox thread, a guest's claim thread): its box, which holds the reply form, and in it each message as a box of its
 * own: the store's (`message`) and the buyer's (`message-own`), told apart by side and by surface. The day and the
 * store's status lines stand on the conversation.
 */
const conversationStyles = (where: { part: string } | { on: string }): Record<string, PrivateStyleSpec> => ({
  conversation: { selector: '[data-part="conversation"]', tokens: [...BOX_TOKENS], kind: "box", surface: "card", ink: "foreground", ...where, fields: true },
  // Their default surfaces come from the conversation's own row: the store's a step from it, the buyer's its link colour.
  message: { selector: '[data-part="message"]', tokens: [...MESSAGE_TOKENS], kind: "box", surface: "under-hover", ink: "foreground", on: "conversation", bare: true },
  "message-own": { selector: '[data-part="message-own"]', tokens: [...MESSAGE_TOKENS], kind: "box", surface: "under-link", ink: "foreground", on: "conversation", bare: true },
});

/**
 * The receipt (`/order-success`, the confirmation and the order's status
 * view, and the theme editor's sample receipt): the order's state, its
 * tracking, the order with its totals, where it goes, what was bought, the
 * account and support actions, the conversation with the store and the apps'
 * targets. Every card a buyer must read is mandatory: a theme orders and lays
 * them out and gives them their look, never leaves one out.
 */
const RECEIPT_STYLES: Record<string, PrivateStyleSpec> = {
  ...withoutNotices(RECEIPT_PAGE_STYLES.head),
  // The recommendations keep the store's own look (private-tokens.ts PRIVATE_OWN_LOOK_HOOKS): no row reaches their buttons.
  action: { ...RECEIPT_PAGE_STYLES.head.action!, selector: `${RECEIPT_PAGE_STYLES.head.action!.selector}:not([data-part="recommendations"] *)` },
  // The order's state: its mark, title (the page's h1), message and next steps; the payment retry under them.
  status: { selector: '[data-part="status"]', tokens: [...BOX_TOKENS], kind: "box", surface: "under", ink: "foreground", part: "status" },
  "status-mark": { selector: '[data-part="status-mark"]', tokens: ["background", "text", "border", "border-width", "radius"], kind: "text", surface: "under", ink: "primary", on: "status" },
  "status-title": { selector: '[data-part="status-title"]', tokens: [...TEXT_TOKENS], kind: "text", surface: "under", ink: "foreground", on: "status" },
  "status-message": { selector: '[data-part="status-message"]', tokens: ["text", "size", "weight", "leading"], kind: "text", surface: "under", ink: "muted-foreground", on: "status" },
  "status-steps": { selector: '[data-part="status-steps"]', tokens: [...BOX_TOKENS], kind: "box", surface: "under", ink: "foreground", on: "status" },
  // A way to pay again (each method the order may still be paid with, one press starts it): an outlined main action,
  // found by its edge at 3:1 on the state's box (by its fill where the theme draws no border); the method it was
  // started with marked by its link colour and its words.
  "status-retry": { selector: '[data-part="status-retry"]', tokens: ["background", "text", "muted", "link", "border", "border-width", "radius", "ring"], kind: "control", surface: "under", ink: "foreground", on: "status", boundary: "edge" },
  // The card form's Pay, under the methods.
  submit: payStyle("status", { size: 14, weight: 600 }),
  tracking: { selector: '[data-part="tracking"]', tokens: [...BOX_TOKENS], kind: "box", surface: "background", ink: "foreground", part: "tracking" },
  // The order card: its facts (the order number and its state among them), then the money rows and the total.
  order: { selector: '[data-part="order"]', tokens: [...BOX_TOKENS], kind: "box", surface: "background", ink: "foreground", part: "summary" },
  "order-facts": { selector: '[data-part="order-facts"]', tokens: ["text", "muted", "size"], kind: "text", surface: "under", ink: "foreground", on: "order" },
  "status-badge": statusBadge("order-facts"),
  // The money block inside the order card; the total and its label drawn at the card's 16px.
  ...privateSummaryStyles({ on: "order", rows: { size: 16, weight: 500 }, total: { size: 16, weight: 600 }, label: { size: 16, weight: 600 }, over: { "line-price": ["size"] } }),
  // Where it goes: the buyer's own name, address and contact.
  delivery: { selector: '[data-part="delivery"]', tokens: [...BOX_TOKENS], kind: "box", surface: "background", ink: "foreground", part: "delivery" },
  "section-heading": { selector: '[data-part="section-heading"]', tokens: [...TEXT_TOKENS], kind: "text", surface: "under", ink: "foreground", on: "delivery" },
  "delivery-contact": { selector: '[data-part="delivery-contact"]', tokens: ["text", "muted", "size"], kind: "text", surface: "under", ink: "foreground", on: "delivery" },
  // What was bought: the card, its heading and each line.
  lines: { selector: '[data-part="lines"]', tokens: [...BOX_TOKENS], kind: "box", surface: "background", ink: "foreground", part: "lines" },
  "lines-heading": { selector: '[data-part="lines-heading"]', tokens: [...TEXT_TOKENS], kind: "text", surface: "under", ink: "foreground", on: "lines" },
  ...afterOrderLineStyles("lines", { imageBox: false }),
  // A review's stars under a line (the buyer's own review, the form's star picker).
  rating: ratingStyle(["line"]),
  // The order's conversation with the store (it holds the reply form) and its messages.
  ...conversationStyles({ part: "conversation" }),
  ...RECEIPT_PAGE_STYLES.tail,
};

const RECEIPT_PAGE: PrivatePageSpec = {
  root: "receipt",
  // `standard`: one column (48rem); `wide`: room for two (64rem).
  frames: ["standard", "wide"],
  parts: {
    progress: part(false, ["progress"]),
    status: part(true, ["status", "status-mark", "status-title", "status-message", "status-steps", "status-retry", "pay"]),
    // The order's way to the buyer (its status view, when the order has tracking).
    tracking: part(true, ["tracking"]),
    // The order's number, state and payment, then every money row and the total.
    summary: part(true, ["order", "order-facts", "order-number", "status-badge", "summary", "summary-heading", "summary-total-label", "add-on-details", "add-on-detail"]),
    delivery: part(true, ["delivery", "section-heading", "delivery-contact"]),
    lines: part(true, ["lines", "lines-heading", "line", "line-image", "line-title", "line-details", "line-price", "line-extras", "rating"]),
    // The account and support actions (an account to make, a request to send): fields and buttons.
    actions: part(true, ["actions"], "fields"),
    conversation: part(true, ["conversation", "message", "message-own"], "fields"),
    recommendations: part(false, ["recommendations"]),
  },
  // The confirmation draws `order.confirmation`, the status view `account.order`: each at its node.
  targets: ["order.confirmation", "account.order"],
  lead: ["status", "summary"],
  layouts: ["stack", "columns", "grid", "group"],
  styles: actionApart("receipt", RECEIPT_STYLES),
  layout: [
    p("progress"),
    p("status"),
    p("tracking"),
    l("stack", [p("summary"), p("delivery"), p("lines")]),
    t("order.confirmation"),
    t("account.order"),
    p("actions"),
    p("conversation"),
    p("recommendations"),
  ],
  items: {},
  ...PRIVATE_PAGE_WORDS.receipt,
};

/**
 * The account (every route `PRIVATE_PAGE_ROUTES.account` names: each page
 * under `/account` and a guest's claim thread): one shell (its navigation with
 * Sign out, the page's heading) around the page's content. The content's
 * elements a theme styles are the same on every account page: its cards (an
 * edit dialog is a card over the page), a state's pill, an order's lines and
 * totals, a line's delivery message and its reveal, a conversation and its
 * messages, and every filled button (one that removes something included):
 * each found by its words, as every ordinary button; only Pay (a control that
 * starts a payment, a main action) and a dialog's Confirm by their fill or edge.
 */
const ACCOUNT_STYLES: Record<string, PrivateStyleSpec> = {
  ...withoutNotices(ACCOUNT_PAGE_STYLES.head),
  // Every filled button that removes something (Remove address, Remove a saved card): found by its words, which read on
  // its fill, as `action`'s do; its fill is not checked against what is around it.
  "action-critical": { ...ACCOUNT_PAGE_STYLES.head.action!, selector: ACCOUNT_PAGE_STYLES.head.action!.selector.replace(".bg-primary:is(", ".bg-destructive:is("), surface: "destructive", ink: "destructive-foreground", hostWeight: 500 },
  // The shell: the navigation (each page, the current one, Sign out) and the page's heading.
  navigation: { selector: '[data-part="navigation"]', tokens: [...BOX_TOKENS], kind: "box", surface: "under", ink: "foreground", part: "navigation" },
  "nav-item": { selector: '[data-part="nav-item"]:not([aria-current="page"])', tokens: ["text", "size", "weight", "radius", "ring"], kind: "control", surface: "under", ink: "muted-foreground", on: "navigation" },
  // The current page: its words, and its marker in the link colour.
  // A tab's count (Inbox 2): a pill filled with the menu's link colour, its number readable on it.
  "nav-badge": { selector: '[data-part="nav-badge"]', tokens: ["background", "text", "radius"], kind: "text", surface: "under-link", ink: "foreground", on: "navigation" },
  "nav-current": { selector: '[data-part="nav-item"][aria-current="page"]', tokens: ["text", "link", "size", "weight", "radius", "ring"], kind: "control", surface: "under", ink: "foreground", on: "navigation" },
  "sign-out": { selector: '[data-part="sign-out"]', tokens: ["background", "text", "border", "border-width", "radius", "ring", "inset", "weight", "size"], kind: "control", surface: "under", ink: "muted-foreground", on: "navigation", boundary: "edge" },
  "heading-title": { selector: '[data-part="heading-title"]', tokens: [...TEXT_TOKENS], kind: "text", surface: "under", ink: "foreground", part: "heading" },
  "heading-intro": { selector: '[data-part="heading-intro"]', tokens: ["text", "size", "weight", "leading"], kind: "text", surface: "under", ink: "muted-foreground", part: "heading" },
  "heading-back": { selector: '[data-part="heading-back"]', tokens: ["text", "radius", "ring"], kind: "control", surface: "under", ink: "muted-foreground", part: "heading" },
  // The page's content, with the apps' account targets in it. It takes no tokens: most account pages draw no box of
  // their own around it (only the workspace layout does), so it never paints; what stands in it stands on the page.
  content: { selector: '[data-part="content"]', tokens: [], kind: "box", surface: "under", ink: "foreground", part: "content", targets: ["account.overview", "account.order", "account.profile"] },
  card: { selector: '[data-part="card"]', tokens: [...BOX_TOKENS, "gap"], kind: "box", surface: "card", ink: "foreground", on: "content", fields: true, opaque: true },
  // An order's payment methods to choose between (its payment card): the chosen one's edge in the row's link colour, the
  // others' in its border colour, clearly apart; never by colour alone: the chosen one also shows a dot in its round mark,
  // as on the payment step.
  "payment-choices": { selector: '[data-part="payment-choices"]', tokens: ["link", "border"], kind: "box", surface: "under", ink: "foreground", on: "card", chosen: true },
  // Pay for the chosen method (what is left to pay, or again after a failed payment): a main action.
  submit: payStyle("card", { size: 14, weight: 500 }),
  "card-title": { selector: '[data-part="card-title"]', tokens: [...TEXT_TOKENS], kind: "text", surface: "under", ink: "foreground", on: "card" },
  "status-badge": statusBadge("card"),
  // An order's totals inside its card, drawn at the card's 14px; what is left to pay (`due`) ranks with the total.
  ...privateSummaryStyles({ on: "card", rows: { size: 14, weight: 400 }, total: { size: 14, weight: 600 }, label: { size: 14, weight: 600 }, due: true, over: { "line-price": ["size"] } }),
  ...afterOrderLineStyles("card", { imageBox: true }),
  // A review's stars: in the reviews' cards, and under an order's line.
  rating: ratingStyle(["card", "line"]),
  // A line's delivery message (the store's words for it) and the control that reveals it.
  "delivery-message": { selector: '[data-part="delivery-message"]', tokens: [...BOX_TOKENS], kind: "box", surface: "under", ink: "foreground", on: "line" },
  // An outlined control: with its border drawn its edge reads 3:1 on the box around it, without one its fill does.
  "delivery-reveal": { selector: '[data-part="delivery-reveal"]', tokens: [...BUTTON_TOKENS], kind: "control", surface: "background", ink: "foreground", on: "delivery-message", boundary: "edge" },
  // An order's conversation, an inbox thread and a guest's claim thread, as on the receipt.
  ...conversationStyles({ on: "content" }),
  ...ACCOUNT_PAGE_STYLES.tail,
};

const ACCOUNT_PAGE: PrivatePageSpec = {
  root: "account",
  parts: {
    // `tabs`: a strip over the page; `sidebar`: a list beside it on a wide screen (the strip on phones).
    navigation: part(true, ["navigation", "nav-item", "nav-badge", "sign-out"], null, ["tabs", "sidebar"]),
    heading: part(true, ["heading", "heading-title", "heading-intro", "heading-back"]),
    content: part(true, ["content", "card", "card-title", "status-badge", "summary", "summary-total-label", "add-on-details", "add-on-detail", "line", "line-image", "line-title", "line-details", "line-price", "delivery-message", "delivery-reveal", "conversation", "message", "message-own", "rating", "payment-choices", "pay"], "fields"),
  },
  targets: [],
  lead: ["heading", "content"],
  layouts: ["stack", "columns", "grid", "group"],
  styles: actionApart("account", ACCOUNT_STYLES),
  layout: [p("navigation"), p("heading"), p("content")],
  items: {},
  ...PRIVATE_PAGE_WORDS.account,
};

// ─── The phone tab bar (`tabBar`) ──────────────────────────────────────────

/**
 * The store's phone tab bar (`blocks.mobileNav` `bottom-tabs`), on every page that draws it, public and private:
 * one look by tokens (private-tab-bar.ts writes and checks it), no arrangement. Its words are the theme's tabs.
 */
const TAB_BAR_ROOT = '[data-private="tab-bar"]';
const TAB_BAR: PrivatePageSpec = {
  root: "tab-bar",
  // Not a part an arrangement places (the bar takes none): the bar itself, drawn by the store wherever the theme's
  // phone navigation is the tab bar.
  parts: { bar: part(false, ["tab-bar", "tab", "tab-label", "tab-icon", "tab-badge"]) },
  targets: [],
  layouts: [],
  styles: {
    // The bar: its colour (blurred at 94% over the page, or solid), its top edge and its height (the page reserves it).
    bar: { selector: TAB_BAR_ROOT, absolute: true, tokens: ["background", "border", "height", "backdrop"], kind: "box", surface: "background", ink: "foreground" },
    // Every tab's label and icon colour, the label's type and its lines (`clamp`, on the bar 1 or 2; 2 by default: a label is never cut).
    label: { selector: `${TAB_BAR_ROOT} [data-part="tab-label"]`, absolute: true, tokens: ["text", "size", "weight", "case", "tracking", "clamp"], kind: "text", surface: "under", ink: "muted-foreground", on: "bar", hostSize: 12, hostWeight: 500 },
    // The current tab (`aria-current`): its colour and weight, its icon's chip and a ring around it.
    current: { selector: `${TAB_BAR_ROOT} [data-part="tab"][aria-current]`, absolute: true, tokens: ["text", "weight", "background", "padding", "ring", "ring-width"], kind: "text", surface: "under", ink: "foreground", on: "bar", hostWeight: 600 },
    // Each tab's icon, in its tab's colour: its size and an optional chip (fill, edge, corners, room around the icon).
    icon: { selector: `${TAB_BAR_ROOT} [data-part="tab-icon"]`, absolute: true, tokens: ["size", "background", "border", "border-width", "radius", "padding"], kind: "box", surface: "under", ink: "muted-foreground", on: "bar", graphic: true },
    // The cart count.
    badge: { selector: `${TAB_BAR_ROOT} [data-part="tab-badge"]`, absolute: true, tokens: ["background", "text"], kind: "box", surface: "destructive", ink: "destructive-foreground", on: "bar" },
  },
  layout: [p("bar")],
  items: {},
  ...PRIVATE_PAGE_WORDS.tabBar,
};

/**
 * Every private page the model draws, by its key in the theme document's
 * `privatePages.pages`.
 */
export const PRIVATE_PAGES = {
  cart: CART_PAGE,
  cartDrawer: CART_DRAWER,
  checkout: CHECKOUT_PAGE,
  receipt: RECEIPT_PAGE,
  account: ACCOUNT_PAGE,
  tabBar: TAB_BAR,
} as const satisfies Record<PrivatePageKey, PrivatePageSpec>;

/** The hook every private surface's root carries (`data-private="<root>"`): the stylesheet's scope. */
export const PRIVATE_SCOPE_ATTRIBUTE = "data-private";
/** The hook on each part's elements. */
export const PRIVATE_PART_ATTRIBUTE = "data-part";
/** A layout node's theme hook (`data-hook="<name>"`), the name its tokens take (`@<hook>`). */
export const PRIVATE_HOOK_ATTRIBUTE = "data-hook";
/** A theme hook: lowercase words joined by hyphens (`studio-summary`). */
export const PRIVATE_HOOK_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+){0,5}$/;

/** Surfaces besides the pages that carry the scope: the store's dialogs and its own chrome there. */
export const PRIVATE_SCOPES = ["dialog", "core-header", "core-footer"] as const;

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
    for (const [name, style] of Object.entries(spec.styles)) lines.push(`${page} style ${name} ${style.absolute ? "" : "<root> "}${style.selector || "<root>"} tokens=${style.tokens.join(",")}${style.fields ? " fields" : ""}${style.targets ? ` targets=${style.targets.join(",")}` : ""}${style.outside ? ` outside-when=${style.outside.join("|")}` : ""}${style.boundary ? ` boundary=${style.boundary}` : ""}${style.bare ? " bare" : ""}${style.within ? ` within=${style.within.join("|")}` : ""}${style.graphic ? " graphic" : ""}${style.chosen ? " chosen" : ""}${style.opaque ? " opaque" : ""}${style.outranks ? ` outranks=${[...Object.entries(style.outranks.over).map(([other, by]) => `${other}:${by.join("+")}`), ...(style.outranks.apps ?? []).map((target) => `ui/${target}:size`)].join(",")}` : ""}`);
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
  // The phone tab bar's own bounds and choices (private-tab-bar.ts), where they differ from a token's everywhere else:
  // a choice a line of its own, so one more is growth.
  for (const [name, [least, most]] of Object.entries(PRIVATE_TAB_BAR_BOUNDS)) lines.push(`tabBar bound ${name} ${least}..${most}px`);
  for (const [name, values] of Object.entries(PRIVATE_TAB_BAR_CHOICES)) for (const value of values) lines.push(`tabBar choice ${name} ${value}`);
  for (const [kind, style] of Object.entries(PRIVATE_BUYER_UI_STYLES)) lines.push(`buyer-ui style ui.${kind}${style.tones ? `[.${style.tones.join("|")}]` : ""}[@<app>][/<target>] ${style.kind} tokens=${style.tokens.join(",")}`);
  return lines;
}
