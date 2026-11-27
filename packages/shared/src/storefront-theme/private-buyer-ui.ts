// The apps' buyer UI on a private page: each node kind an app's block draws
// (host markup from typed nodes, apps/storefront/src/lib/buyer-ui), what it
// is to the colour table and the tokens a theme gives it under
// `ui.<kind>[.<tone>][@<app>][/<target>]` (private-tokens.ts walks this table
// at every target of the page). Data only (no zod).
import type { PrivatePaletteRole, PrivateStyleKind, PrivateTokenName } from "./private-anatomy";

/** The buyer UI's tones (an app's banner, badge, toned stack, mark and text), each with its rows in the colour table. */
export const PRIVATE_UI_TONES = ["neutral", "info", "success", "warning", "critical"] as const;
export type PrivateUiTone = (typeof PRIVATE_UI_TONES)[number];
/** An app button's own tones (ui.ts `PluginUiButton.tone`; an untoned button is drawn `secondary`). */
export const PRIVATE_UI_BUTTON_TONES = ["primary", "secondary", "critical"] as const;
export type PrivateUiButtonTone = (typeof PRIVATE_UI_BUTTON_TONES)[number];
export type PrivateUiStyleTone = PrivateUiTone | PrivateUiButtonTone;

/** An app node kind's style target (`ui.<kind>`): what it is to the colour table, by tone. */
export interface PrivateBuyerUiStyle {
  /** The node's selector inside its block (`data-ui`, with `data-tone` added per tone). */
  readonly kind: string;
  readonly tones?: readonly PrivateUiStyleTone[];
  readonly tokens: readonly PrivateTokenName[];
  /** Null for a node that draws no colour (a row of nodes): it has no row in the table. */
  readonly style: PrivateStyleKind | null;
  /** The palette role of its own words, per tone (`critical` words are the error colour). */
  readonly ink?: PrivatePaletteRole;
  readonly toneInk?: Partial<Record<PrivateUiStyleTone, PrivatePaletteRole>>;
  /**
   * Its children are drawn on its own surface (a banner's buttons, a toned
   * stack's pieces, a disclosure's body): every other kind and tone has a
   * row inside each of its rows, so what it holds is checked on it.
   */
  readonly container?: true;
  /** A container's children by kind (`button`: a banner holds only its actions); absent: every kind. */
  readonly holds?: readonly string[];
  /**
   * `fill`: where the theme fills it (`background`, `gradient`), a filled button, found on each surface around it as
   * the store's filled buttons are (private-anatomy.ts `boundary`): by its fill, or by a solid edge of at least 2px.
   * Left unfilled it draws the store's outlined button, named by its words.
   */
  readonly boundary?: "fill";
}

const CRITICAL_INK = { critical: "destructive" } as const;

/**
 * An app's buyer UI block is host-drawn from typed nodes: a host part. A
 * theme gives each node kind a look by tokens under `ui.<kind>`, narrowed by
 * tone (`ui.banner.warning`), app (`@acme.protection`) and target
 * (`/cart.line.after`). Each kind and tone has a row in the colour table at
 * every one of the page's targets, on whatever that target sits on.
 * Kind names are lowercase letters (the token key's grammar).
 */
export const PRIVATE_BUYER_UI_STYLES: Readonly<Record<string, PrivateBuyerUiStyle>> = {
  banner: { kind: '[data-ui="banner"]', tones: PRIVATE_UI_TONES, tokens: ["background", "text", "border", "border-width", "radius", "shadow", "padding"], style: "box", ink: "foreground", toneInk: CRITICAL_INK, container: true, holds: ["button"] },
  // A toned stack (an offer row, a status box): a surface whose pieces sit in a row where it is wide enough.
  stack: { kind: '[data-ui="stack"][data-tone]', tones: PRIVATE_UI_TONES, tokens: ["background", "text", "border", "border-width", "radius", "shadow", "padding", "gap"], style: "box", ink: "foreground", toneInk: CRITICAL_INK, container: true },
  // Toned by the button's own tone (on the element itself), so a theme fills "Add" and leaves "Remove" outlined.
  button: { kind: ':is(a[data-ui="button"],[data-ui="button"]>button)', tones: PRIVATE_UI_BUTTON_TONES, tokens: ["background", "text", "border", "border-width", "radius", "ring", "inset", "weight", "size", "case"], style: "control", ink: "foreground", boundary: "fill" },
  badge: { kind: '[data-ui="badge"]', tones: PRIVATE_UI_TONES, tokens: ["background", "text", "border", "radius", "padding", "inset", "weight", "size"], style: "text", ink: "foreground", toneInk: CRITICAL_INK },
  // A tone's glyph in a circle: its words' colour, the circle's border and its size (the circle is twice it).
  mark: { kind: '[data-ui="mark"]', tones: PRIVATE_UI_TONES, tokens: ["text", "border", "size"], style: "text", ink: "foreground", toneInk: CRITICAL_INK },
  text: { kind: '[data-ui="text"]', tones: PRIVATE_UI_TONES, tokens: ["text", "font", "size", "weight", "leading"], style: "text", ink: "foreground", toneInk: CRITICAL_INK },
  heading: { kind: '[data-ui="heading"]', tokens: ["text", "size", "weight", "font", "case"], style: "text", ink: "foreground" },
  link: { kind: 'a[data-ui="link"]', tokens: ["text", "size", "weight"], style: "text", ink: "foreground" },
  // Labels are its muted words, values its text.
  keyvalue: { kind: '[data-ui="key-value"]', tokens: ["text", "muted", "size", "weight"], style: "text", ink: "foreground" },
  disclosure: { kind: '[data-ui="disclosure"]', tokens: ["background", "text", "border", "radius"], style: "box", ink: "foreground", container: true },
  row: { kind: ':is([data-ui="stack"],[data-ui="columns"])', tokens: ["gap"], style: null },
};

/**
 * The store's own filled action on a page (Place order on the cart): no app
 * button, in any tone, is drawn larger or heavier than it. The same
 * comparison as an anatomy target's `outranks` (private-tokens.ts `declared`).
 */
export const PRIVATE_UI_BUTTON_UNDER = "submit";

/**
 * Every `ui.button…` key whose `size` or `weight` passes the store's action
 * as drawn on the page (`drawn`: its declared size or weight; undefined where
 * the page has no such action). Reason `prominence`.
 */
export function buyerUiButtonProminenceIssues(
  page: string,
  tokens: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  drawn: (by: "size" | "weight") => number | undefined,
): Array<{ path: Array<string | number>; reason: "prominence"; message: string }> {
  const issues: Array<{ path: Array<string | number>; reason: "prominence"; message: string }> = [];
  for (const [key, values] of Object.entries(tokens)) {
    if (!/^ui\.button(?:[.@/]|$)/.test(key)) continue;
    for (const by of ["size", "weight"] as const) {
      const mine = values[by] === undefined ? undefined : Number(values[by]);
      const theirs = drawn(by);
      if (mine === undefined || theirs === undefined || mine <= theirs) continue;
      const unit = by === "size" ? "px" : "";
      issues.push({ path: ["privatePages", "tokens", page, key], reason: "prominence", message: `${key} is drawn at ${by === "weight" ? "weight " : ""}${mine}${unit}, over the store's own action at ${theirs}${unit}: an app's button never reads stronger than the store's action.` });
    }
  }
  return issues;
}
