// The apps' buyer UI on a private page: each node kind an app's block draws
// (host markup from typed nodes, apps/storefront/src/lib/buyer-ui), what it
// is to the colour table and the tokens a theme gives it under
// `ui.<kind>[.<tone>][@<app>][/<target>]` (private-tokens.ts walks this table
// at every target of the page). Data only (no zod).
import type { PrivatePaletteRole, PrivateStyleKind, PrivateTokenName } from "./private-anatomy";

/** The buyer UI's tones (an app's banner and badge), each with its rows in the colour table. */
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
}

/**
 * An app's buyer UI block is host-drawn from typed nodes: a host part. A
 * theme gives each node kind a look by tokens under `ui.<kind>`, narrowed by
 * tone (`ui.banner.warning`), app (`@acme.protection`) and target
 * (`/cart.line.after`). Each kind and tone has a row in the colour table at
 * every one of the page's targets, on whatever that target sits on.
 */
export const PRIVATE_BUYER_UI_STYLES: Readonly<Record<string, PrivateBuyerUiStyle>> = {
  banner: { kind: '[data-ui="banner"]', tones: PRIVATE_UI_TONES, tokens: ["background", "text", "border", "border-width", "radius", "shadow", "padding"], style: "box", ink: "foreground", toneInk: { critical: "destructive" } },
  button: { kind: ':is(a[data-ui="button"],[data-ui="button"]>button)', tokens: ["background", "text", "border", "border-width", "radius", "ring", "weight", "size", "case"], style: "control", ink: "foreground" },
  badge: { kind: '[data-ui="badge"]', tones: PRIVATE_UI_TONES, tokens: ["background", "text", "border", "radius"], style: "text", ink: "foreground", toneInk: { critical: "destructive" } },
  text: { kind: '[data-ui="text"]', tokens: ["text", "size", "weight"], style: "text", ink: "foreground" },
  heading: { kind: '[data-ui="heading"]', tokens: ["text", "size", "weight", "font", "case"], style: "text", ink: "foreground" },
  disclosure: { kind: '[data-ui="disclosure"]', tokens: ["background", "text", "border", "radius"], style: "box", ink: "foreground" },
  row: { kind: ':is([data-ui="stack"],[data-ui="columns"])', tokens: ["gap"], style: null },
};

