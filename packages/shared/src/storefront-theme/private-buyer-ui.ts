// The apps' buyer UI on a private page: each node kind an app's block draws
// (host markup from typed nodes, apps/storefront/src/lib/buyer-ui), what it
// is to the colour table and the tokens a theme gives it under
// `ui.<kind>[.<tone>][@<app>][/<target>]` (private-tokens.ts walks this table
// at every target of the page). Data only (no zod).
import type { PrivatePaletteRole, PrivateStyleKind, PrivateTokenName } from "./private-anatomy";

/** The buyer UI's tones (an app's banner, badge, toned stack, mark and text), each with its rows in the colour table. */
export const PRIVATE_UI_TONES = ["neutral", "info", "success", "warning", "critical"] as const;
export type PrivateUiTone = (typeof PRIVATE_UI_TONES)[number];

/** An app node kind's style target (`ui.<kind>`): what it is to the colour table, by tone. */
export interface PrivateBuyerUiStyle {
  /** The node's selector inside its block (`data-ui`, with `data-tone` added per tone). */
  readonly kind: string;
  readonly tones?: readonly PrivateUiTone[];
  readonly tokens: readonly PrivateTokenName[];
  /** Null for a node that draws no colour (a row of nodes): it has no row in the table. */
  readonly style: PrivateStyleKind | null;
  /** The palette role of its own words, per tone (`critical` words are the error colour). */
  readonly ink?: PrivatePaletteRole;
  readonly toneInk?: Partial<Record<PrivateUiTone, PrivatePaletteRole>>;
  /**
   * Its children are drawn on its own surface (a banner's buttons, a toned
   * stack's pieces, a disclosure's body): every other kind and tone has a
   * row inside each of its rows, so what it holds is checked on it.
   */
  readonly container?: true;
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
  banner: { kind: '[data-ui="banner"]', tones: PRIVATE_UI_TONES, tokens: ["background", "text", "border", "border-width", "radius", "shadow", "padding"], style: "box", ink: "foreground", toneInk: CRITICAL_INK, container: true },
  // A toned stack (an offer row, a status box): a surface whose pieces sit in a row where it is wide enough.
  stack: { kind: '[data-ui="stack"][data-tone]', tones: PRIVATE_UI_TONES, tokens: ["background", "text", "border", "border-width", "radius", "shadow", "padding", "gap"], style: "box", ink: "foreground", toneInk: CRITICAL_INK, container: true },
  button: { kind: ':is(a[data-ui="button"],[data-ui="button"]>button)', tokens: ["background", "text", "border", "border-width", "radius", "ring", "weight", "size", "case"], style: "control", ink: "foreground" },
  badge: { kind: '[data-ui="badge"]', tones: PRIVATE_UI_TONES, tokens: ["background", "text", "border", "radius", "padding", "weight", "size"], style: "text", ink: "foreground", toneInk: CRITICAL_INK },
  // A tone's glyph in a circle: its words' colour, the circle's border and its size (the circle is twice it).
  mark: { kind: '[data-ui="mark"]', tones: PRIVATE_UI_TONES, tokens: ["text", "border", "size"], style: "text", ink: "foreground", toneInk: CRITICAL_INK },
  text: { kind: '[data-ui="text"]', tones: PRIVATE_UI_TONES, tokens: ["text", "size", "weight"], style: "text", ink: "foreground", toneInk: CRITICAL_INK },
  heading: { kind: '[data-ui="heading"]', tokens: ["text", "size", "weight", "font", "case"], style: "text", ink: "foreground" },
  link: { kind: 'a[data-ui="link"]', tokens: ["text", "size", "weight"], style: "text", ink: "foreground" },
  // Labels are its muted words, values its text.
  keyvalue: { kind: '[data-ui="key-value"]', tokens: ["text", "muted", "size", "weight"], style: "text", ink: "foreground" },
  disclosure: { kind: '[data-ui="disclosure"]', tokens: ["background", "text", "border", "radius"], style: "box", ink: "foreground", container: true },
  row: { kind: ':is([data-ui="stack"],[data-ui="columns"])', tokens: ["gap"], style: null },
};
