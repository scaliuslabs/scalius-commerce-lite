// The buyer's private pages as named host parts (docs: packages/plugin-sdk/docs/private-pages.md).
//
// Each private page is drawn by the host from named parts. A part is core
// markup with stable `data-part` hooks inside it; a theme arranges parts,
// its own content blocks and the apps' extension targets in a tree of
// layout nodes (private-arrangement.ts) and styles the hooks with a scoped
// stylesheet (private-css.ts). No theme or app script ever runs on these
// pages. Each page says which parts a buyer must see and do (mandatory:
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
// parts, targets, layouts, default layout, items, labels and icons) and add
// it to `PRIVATE_PAGES`. Its default layout must hold every mandatory part
// and target exactly once.

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
  /** Its `data-part` hooks, its own name first. */
  readonly hooks: readonly string[];
  /** Selectors of what the theme's stylesheet may never hide (the visibility guard checks each match). */
  readonly guard?: readonly string[];
}

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

/** A label the theme may reword, and its longest words. */
export interface PrivateLabelSpec {
  readonly max: number;
}

export interface PrivatePageSpec extends PrivateUnitSpec {
  /** The `data-private` value of its root (the stylesheet's scope). */
  readonly root: string;
  /** The page frame's closed variants, the first the default. */
  readonly frames?: readonly [string, ...string[]];
  /** The hooks a host layout draws inside itself (the fold's bar and body). */
  readonly layoutHooks?: Partial<Record<PrivateLayoutKind, readonly string[]>>;
  /** Repeated units, by name. */
  readonly items: Readonly<Record<string, PrivateUnitSpec>>;
  /** Host labels the theme may reword (plain text, per language). */
  readonly labels: Readonly<Record<string, PrivateLabelSpec>>;
  /** Host icons the theme may replace with its own image. */
  readonly icons: readonly string[];
}

const part = (mandatory: boolean, hooks: readonly string[], extra: Omit<PrivatePartSpec, "mandatory" | "hooks"> = {}): PrivatePartSpec => ({ mandatory, hooks, ...extra });
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
  quantity: part(true, ["line-quantity"], { guard: ['[data-part="line-quantity"]'] }),
  price: part(true, ["line-price"], { guard: ['[data-part="line-price"]'] }),
  remove: part(true, ["line-remove"], { guard: ['[data-part="line-remove"]'] }),
  limit: part(true, ["line-limit"]),
  issue: part(true, ["line-issue"]),
  rule: part(true, ["line-rule"]),
} as const satisfies Record<string, PrivatePartSpec>;

/** The line's own hook (its root). */
export const PRIVATE_LINE_HOOK = "line";

/** The cart page: the information step (lines, totals, the details form and its submit). */
const CART_PAGE: PrivatePageSpec = {
  root: "cart",
  frames: ["standard", "narrow"],
  layoutHooks: { fold: ["fold-toggle", "fold-body"] },
  parts: {
    progress: part(false, ["progress"]),
    notices: part(true, ["notice"]),
    lines: part(true, ["lines", "lines-heading", "lines-continue", "lines-loading", "lines-list", "lines-clear", "lines-undo", "cart-empty", "cart-empty-icon"]),
    // Its money rows carry `data-summary-row` (subtotal, add-on, delivery, discount, tax, total), as on every surface.
    summary: part(true, ["summary", "summary-validation"], { guard: ['[data-summary-row="total"]'] }),
    discount: part(false, ["discount"]),
    details: part(true, ["details", "details-sign-in", "details-form", "contact", "delivery", "details-errors", "details-submit", "legal"], { guard: ['[data-part="details-submit"]', '[data-part="contact"]', '[data-part="delivery"]'] }),
    empty: part(false, ["empty-extras"]),
  },
  targets: ["cart.page.summary", "cart.page.below"],
  layouts: ["stack", "columns", "grid", "group", "fold"],
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
    "cart.continue": { max: 40 },
    "cart.empty": { max: 80 },
    "cart.emptyText": { max: 200 },
    "cart.subtotal": { max: 40 },
    "cart.showSummary": { max: 40 },
    "cart.hideSummary": { max: 40 },
    "dialog.goBack": { max: 30 },
    "dialog.confirm": { max: 30 },
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
    summary: part(true, ["drawer-summary", "drawer-total", "drawer-blocked"], { guard: ['[data-summary-row="total"]'] }),
    actions: part(true, ["drawer-checkout", "drawer-actions", "drawer-view-cart", "drawer-continue"], { guard: ['[data-part="drawer-checkout"]'] }),
  },
  targets: ["cart_drawer.footer"],
  layouts: ["stack", "columns", "grid", "group", "scroll"],
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
    "drawer.checkout": { max: 30 },
    "drawer.viewCart": { max: 30 },
    "drawer.continue": { max: 40 },
    "drawer.empty": { max: 80 },
    "drawer.startShopping": { max: 30 },
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
 * The store's dialogs over a private page (`data-private="dialog"`): the
 * confirmation an app's choice asks for, and sign-in (`sign-in`).
 */
export const PRIVATE_DIALOG_HOOKS = ["sign-in", "dialog-title", "dialog-text", "dialog-agree", "dialog-actions", "dialog-back", "dialog-confirm"] as const;

/**
 * An app's buyer UI block, wherever a private page draws it: its mount's
 * `data-buyer-ui-target`, the block's `data-buyer-ui-app` (the app's id) and
 * each node's kind on `data-ui` (`banner`, `text`, `button`, …). A theme's
 * content blocks carry the same `data-ui` kinds.
 */
export const PRIVATE_BUYER_UI_HOOKS = ["data-buyer-ui-target", "data-buyer-ui-app", "data-ui"] as const;

/** Every label key of every page, with its page. */
export function privateLabelKeys(): Array<{ page: PrivatePageKey; key: string; max: number }> {
  return PRIVATE_PAGE_KEYS.flatMap((page) => Object.entries(PRIVATE_PAGES[page].labels).map(([key, spec]) => ({ page, key, max: spec.max })));
}

/** Every selector the visibility guard checks on a page: its parts' and its repeated units'. */
export function privateGuardSelectors(page: PrivatePageKey): string[] {
  const spec: PrivatePageSpec = PRIVATE_PAGES[page];
  const units: PrivateUnitSpec[] = [spec, ...Object.values(spec.items)];
  return [...new Set(units.flatMap((unit) => Object.values(unit.parts).flatMap((entry) => entry.guard ?? [])))];
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
      lines.push(`${prefix} part ${name}${entry.mandatory ? " mandatory" : ""}${entry.variants ? ` variants=${entry.variants.join("|")}` : ""} hooks=${entry.hooks.join(",")}${entry.guard ? ` guard=${entry.guard.join(",")}` : ""}`);
    }
    for (const target of spec.targets) lines.push(`${prefix} target ${target}`);
    lines.push(`${prefix} layouts ${spec.layouts.join(",")}`);
  };
  for (const page of PRIVATE_PAGE_KEYS) {
    const spec: PrivatePageSpec = PRIVATE_PAGES[page];
    lines.push(`${page} root ${PRIVATE_SCOPE_ATTRIBUTE}=${spec.root}${spec.frames ? ` frames=${spec.frames.join("|")}` : ""}`);
    unit(page, spec);
    for (const [kind, hooks] of Object.entries(spec.layoutHooks ?? {})) lines.push(`${page} layout ${kind} hooks=${hooks.join(",")}`);
    for (const [name, item] of Object.entries(spec.items)) {
      lines.push(`${page}.${name} root ${PRIVATE_PART_ATTRIBUTE}=${PRIVATE_LINE_HOOK}`);
      unit(`${page}.${name}`, item);
    }
    for (const [key, label] of Object.entries(spec.labels)) lines.push(`${page} label ${key} max=${label.max}`);
    for (const icon of spec.icons) lines.push(`${page} icon ${icon}`);
  }
  lines.push(`dialog root ${PRIVATE_SCOPE_ATTRIBUTE}=dialog hooks=${PRIVATE_DIALOG_HOOKS.join(",")}`);
  lines.push(`buyer-ui attributes=${PRIVATE_BUYER_UI_HOOKS.join(",")}`);
  lines.push(`chrome roots ${PRIVATE_SCOPE_ATTRIBUTE}=header|footer`);
  return lines;
}
