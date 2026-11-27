// A theme's look for the host parts of a private page: typed tokens, never
// selectors (docs: packages/plugin-sdk/docs/private-pages.md).
//
// Each page names its style targets (private-anatomy.ts `styles`) and the
// tokens each takes; a theme's layout node takes PRIVATE_LAYOUT_TOKENS by its
// hook (`@<hook>`), and an app's buyer UI nodes take tokens by kind
// (`ui.<kind>[.<tone>][@<app>][/<target>]`, PRIVATE_BUYER_UI_STYLES). A theme
// supplies values only, checked by type at save:
// - colours are a palette role (`card`, `primary`) or an opaque `#rrggbb`,
//   or one of each per scheme (`{ "light": "#f2ebd9", "dark": "#35282c" }`):
//   each palette buyers can see resolves its own and is checked on its own;
// - lengths are whole pixels within each token's bounds (text 12 to 40);
// - choices (weight, case, shadow, font role, …) come from a closed list;
// - no value is text CSS reads as code (no var(), calc(), url() or words).
//
// A page with any tokens is drawn in token mode, and every colour a buyer
// reads there comes from one table the save resolves (`privateTokenTables`):
// a row per style target at each place it sits, per palette buyers can see,
// holding its solid surface (or a gradient's points), the colour of its own
// words and of its muted, link and error words, its border and focus ring
// (and a field's placeholder and error border). Each is the theme's token
// where given, else a default that reads on the surface beneath. A filled
// button's fill (or its edge, where the theme draws a solid border of at least
// 2px over a fill clearly a colour of its own), and an outlined control's or a
// field's border (its own fill where the theme draws no border), read at 3:1
// on what is around it. The host
// writes exactly those rows as CSS (`privateTableCss`), and the contrast check
// runs over exactly those rows (`privateTablePairs`): a pair the CSS draws is
// a pair the check reads. Inside the page, the host's palette classes read the
// nearest row (`PRIVATE_TOKEN_MODE_CSS`): a translucent tint or a palette
// colour never decides a colour there.
import { z } from "zod";

export { privateTokensSchema, type PrivateTokens } from "./private-schema";
import { buyerUiButtonProminenceIssues, PRIVATE_UI_BUTTON_UNDER } from "./private-buyer-ui";
import { STOREFRONT_THEME_COLOR_KEYS, STOREFRONT_THEME_MIN_MUTED_ERROR_DISTANCE, storefrontThemeColorDistance, storefrontThemeContrast, storefrontThemeHoverSurface, storefrontThemeMix, type StorefrontThemeColors } from "./contrast";
import { STOREFRONT_RATING_COLOR, storefrontPagePaintColors, storefrontPagePaintCss, storefrontThemeFocusRing, type StorefrontPagePaint } from "./tokens";
import { privateTokensSchema, type PrivateTokens } from "./private-schema";
import {
  PRIVATE_BUYER_UI_STYLES,
  PRIVATE_HOOK_PATTERN,
  PRIVATE_LAYOUT_TOKENS,
  PRIVATE_PAGES,
  PRIVATE_SCOPES,
  type PrivateBuyerUiStyle,
  type PrivateUiTone,
  type PrivateNode,
  type PrivatePageKey,
  type PrivatePageSpec,
  type PrivatePaletteRole,
  type PrivateStyleKind,
  type PrivateStyleSpec,
  type PrivateTokenName,
  type PrivateUnitSpec,
} from "./private-anatomy";

/** The contrast floors: text (WCAG 1.4.3 AA) and a field's marks and focus rings (WCAG 1.4.11). */
export const PRIVATE_CONTRAST_FLOOR = 4.5;
export const PRIVATE_MARK_CONTRAST_FLOOR = 3;
/**
 * A filled button found by a drawn edge rather than its fill: the least
 * border width it draws (px; an unset width draws none)...
 */
export const PRIVATE_EDGE_MIN_WIDTH = 2;
/**
 * ...and how far its fill stays from every point around it (CIE76, the
 * store's "clearly apart"): a fill near what is around it with an edge is an
 * outlined button, Go back's look, never the store's action.
 */
export const PRIVATE_EDGE_FILL_DISTANCE = STOREFRONT_THEME_MIN_MUTED_ERROR_DISTANCE;

const HEX = /^#[0-9a-f]{6}$/;
const oneColorSchema = /* @__PURE__ */ (() => z.union([z.enum(STOREFRONT_THEME_COLOR_KEYS), z.string().regex(HEX)]))();
/**
 * A colour: a palette role or an opaque `#rrggbb`, the same in both schemes,
 * or `{ light, dark }` with one of those each (both: a half value would leave
 * a scheme unsaid). A palette buyers cannot see is never drawn, so its value
 * is not checked (a dark-only theme's `{ light, dark }` draws its dark one);
 * showing that scheme is a save, which checks it.
 */
const colorSchema = /* @__PURE__ */ (() => z.union([oneColorSchema, z.object({ light: oneColorSchema, dark: oneColorSchema }).strict()], {
  error: 'A colour is a palette role, an opaque #rrggbb in lowercase, or { "light": …, "dark": … } with one of those for each scheme.',
}))();
type ColorValue = z.infer<typeof colorSchema>;
/** A colour value as one palette draws it. */
const inScheme = (value: unknown, scheme: "light" | "dark"): unknown => typeof value === "object" && value !== null ? (value as Record<string, unknown>)[scheme] : value;
const gradientSchema = /* @__PURE__ */ (() => z.object({
  shape: z.enum(["linear", "radial"]),
  angle: z.number().int().min(0).max(360).optional(),
  from: colorSchema,
  to: colorSchema,
}).strict())();
type Gradient = z.infer<typeof gradientSchema>;
const trackSchema = /* @__PURE__ */ (() => z.union([z.enum(["auto", "min-content", "1fr", "2fr", "3fr", "4fr"]), z.number().int().min(24).max(480)]))();
const tracksSchema = /* @__PURE__ */ (() => z.array(trackSchema).min(1).max(4))();
type Tracks = z.infer<typeof tracksSchema>;

type TokenSpec = {
  schema: z.ZodType;
  /** Its declarations, from a valid value; none for a colour (the table writes colours). */
  write?(value: never): string;
  /** Where it applies besides the target itself (selector suffixes; "" is the target). */
  on?: readonly string[];
  /** Above the phone width only. */
  wide?: boolean;
};

const px = (min: number, max: number) => z.number().int().min(min).max(max);
// Every track has a floor: 20rem where it holds the page's parts, 4rem inside a repeated unit (a cart
// line). The columns apply only where the box holding the grid fits every track at its floor
// (privateTokenCss), else the host's one column: a part is never squeezed or pushed off its box.
const PAGE_TRACK_FLOOR = 320;
const UNIT_TRACK_FLOOR = 64;
const tracks = (value: Tracks, floor: number) => value.map((track) => `minmax(${floor}px,${typeof track === "number" ? `${track}px` : track})`).join(" ");
const choice = <T extends string>(values: Record<T, string>): Pick<TokenSpec, "schema" | "write"> => ({
  schema: z.enum(Object.keys(values) as [T, ...T[]]),
  write: (value: T) => values[value],
});
/**
 * 7% of the page's width, the bound a `size` scales down to on a narrow page. Every line and layout node is a
 * size container, so `7cqi` at the text would be 7% of its column (an 18px price drawn at 12px in a 171px
 * column). `--pt-fit` is a registered length set to `7cqi` on the page root, so it is computed there, against
 * the box the page sits in (else the screen), and inherits as pixels; outside the root (a dialog) it is 7vw.
 * A browser without `@property` substitutes `7cqi` at the text: 7% of its nearest container, as before.
 */
const PAGE_FIT = "var(--pt-fit,7cqi)";
// The syntax `<length>`, its `<` escaped: a stored look holding one serves nothing (`privatePagesCss`).
const PAGE_FIT_RULE = '@property --pt-fit{syntax:"\\3c length>";inherits:true;initial-value:7vw}';

/** The colour tokens: each is a cell of the table, never a rule of its own. */
export const PRIVATE_COLOUR_TOKENS = ["background", "gradient", "text", "muted", "link", "error", "placeholder", "ring", "invalid", "border"] as const satisfies readonly PrivateTokenName[];

export const PRIVATE_TOKEN_SPECS: Record<PrivateTokenName, TokenSpec> = /* @__PURE__ */ (() => ({
  background: { schema: colorSchema },
  gradient: { schema: gradientSchema },
  text: { schema: colorSchema },
  muted: { schema: colorSchema },
  link: { schema: colorSchema },
  error: { schema: colorSchema },
  placeholder: { schema: colorSchema },
  ring: { schema: colorSchema },
  invalid: { schema: colorSchema },
  border: { schema: colorSchema },
  // A border's colour is its row's (`--pt-b`, always set in token mode).
  "border-width": { schema: px(0, 4), write: (value: number) => `border-width:${value}px;border-color:var(--pt-b)` },
  "border-style": choice({ solid: "border-style:solid;border-color:var(--pt-b)", dashed: "border-style:dashed;border-color:var(--pt-b)", dotted: "border-style:dotted;border-color:var(--pt-b)", none: "border-style:none" }),
  radius: { schema: px(0, 32), write: (value: number) => `border-radius:${value}px` },
  shadow: choice({
    none: "box-shadow:none",
    sm: "box-shadow:0 1px 2px rgb(0 0 0 / 0.12)",
    md: "box-shadow:0 4px 12px rgb(0 0 0 / 0.18)",
    lg: "box-shadow:0 12px 32px rgb(0 0 0 / 0.28)",
  }),
  // Spacing and type scale down on a narrow screen, so no part outgrows a phone.
  // Written by shapeCss, which knows the box's radius: never under 4px nor under 30% of the radius.
  padding: { schema: px(0, 48), write: (value: number) => `padding:min(${value}px,4vw)` },
  gap: { schema: px(0, 48), write: (value: number) => `gap:min(${value}px,4vw)` },
  // A button's room at its sides only: the host keeps its height (44px to tap on a phone).
  inset: { schema: px(0, 32), write: (value: number) => `padding-inline:min(${value}px,4vw)` },
  font: choice({ body: "font-family:var(--theme-font-body)", heading: "font-family:var(--theme-font-heading)", mono: "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,Liberation Mono,monospace" }),
  // On the words inside too, as a size is (the store's type classes set their own): a weight the check ranks is a weight drawn.
  weight: { ...choice({ 400: "font-weight:400", 500: "font-weight:500", 600: "font-weight:600", 700: "font-weight:700", 800: "font-weight:800" }), on: ["", " :where(.text-foreground,.text-card-foreground)"] },
  // Scaled down on a narrow page, never in a narrow column: 7% of the page's width (`PAGE_FIT`), never under 12px.
  size: { schema: px(12, 40), write: (value: number) => `font-size:min(${value}px,max(12px,${PAGE_FIT}))`, on: ["", " :where(.text-foreground,.text-card-foreground)"] },
  // Never under 1.25: lines never overlap. On the words inside too (the store's type classes set their own).
  leading: { ...choice({ tight: "line-height:1.25", snug: "line-height:1.375", normal: "line-height:1.5", relaxed: "line-height:1.625" }), on: ["", " :where(.text-foreground,.text-card-foreground)"] },
  case: choice({ none: "text-transform:none", uppercase: "text-transform:uppercase" }),
  tracking: choice({ normal: "letter-spacing:normal", wide: "letter-spacing:0.04em", wider: "letter-spacing:0.08em" }),
  align: choice({ start: "text-align:start", center: "text-align:center", end: "text-align:end" }),
  // At least two lines: a title is never cut to one. The clamp is the title's link's own, so it never clips the link's focus ring.
  clamp: {
    ...choice({
      none: "display:block;-webkit-line-clamp:none;overflow:visible",
      2: "display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden",
      3: "display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden",
    }),
    on: [" a"],
  },
  // Written by privateTokenCss, which knows the floor of the node's level.
  columns: { schema: tracksSchema },
  "columns-wide": { schema: tracksSchema, wide: true },
  // An image never takes more than 30% of its line (each line is a size container).
  width: { schema: px(40, 240), write: (value: number) => `inline-size:min(${value}px,30cqi)` },
  height: { schema: px(40, 320), write: (value: number) => `block-size:${value}px` },
  "width-wide": { schema: px(40, 240), write: (value: number) => `inline-size:min(${value}px,30cqi)`, wide: true },
  "height-wide": { schema: px(40, 320), write: (value: number) => `block-size:${value}px`, wide: true },
  fit: { ...choice({ contain: "object-fit:contain", cover: "object-fit:cover" }), on: [" img"] },
  "max-width": { schema: px(480, 1600), write: (value: number) => `max-inline-size:${value}px` },
}))();

/** Where a phone ends (the store's `sm`). */
export const PRIVATE_WIDE_MEDIA = "(min-width:40rem)";


export type PrivateTokenReason = "unknown_style" | "unknown_token" | "token_value" | "contrast" | "no_row" | "prominence" | "too_large";

/**
 * What one page's tokens may name, refused (`too_large`) before anything is
 * resolved: style keys, distinct apps (each app's node kinds and tones add
 * rows at every target and inside every box of its that paints), and the
 * rows the colour table would hold per palette. A save stays a bounded cost.
 */
export const PRIVATE_TOKEN_LIMITS = { keys: 160, apps: 4, rows: 6000 } as const;

/** The apps a page's tokens name (`ui.<kind>@<app>…`). */
export function privateTokenApps(tokens: Readonly<Record<string, unknown>> | undefined): string[] {
  return [...new Set(Object.keys(tokens ?? {}).flatMap((key) => { const app = UI_KEY.exec(key)?.[3]; return app ? [app] : []; }))].sort();
}
export interface PrivateTokenIssue {
  path: Array<string | number>;
  reason: PrivateTokenReason;
  message: string;
}

/** The palettes buyers can see: light unless the theme is dark only, dark when it shows dark colours. */
export interface PrivatePalettesInput {
  colors: StorefrontThemeColors;
  darkColors?: StorefrontThemeColors | null;
  colorScheme: "light" | "dark" | "system";
  colorSchemeToggle: boolean;
  /** The theme's page paint (`tokens.pagePaint`): what the page row stands on when its tokens paint nothing. */
  pagePaint?: StorefrontPagePaint | undefined;
}

/** A palette buyers can see, the scheme it is drawn under (`<html data-color-scheme>`) and the page's paint. */
export interface PrivatePalette {
  scheme: "light" | "dark";
  colors: StorefrontThemeColors;
  pagePaint?: StorefrontPagePaint | undefined;
}

/** What a page's tokens are checked against: its arrangement (layout hooks and where each part sits) and the palettes. */
export interface PrivateTokenContext {
  layout: readonly PrivateNode[];
  items: Readonly<Record<string, readonly PrivateNode[]>>;
  palettes: readonly PrivatePalette[];
}

const UI_KEY = /^ui\.([a-z]{1,12})(?:\.([a-z]{1,12}))?(?:@([a-z0-9][a-z0-9.-]{0,63}))?(?:\/([a-z_.]{1,64}))?$/;

/** The page's extension targets: its units' and those its host parts draw inside themselves included. */
const pageTargets = (spec: PrivatePageSpec) => [...spec.targets, ...Object.values(spec.items).flatMap((item) => item.targets), ...Object.values(spec.styles).flatMap((style) => style.targets ?? [])];

/** A theme key's tokens and selector: an anatomy target, or an app node kind narrowed by tone, app and target. */
function styleOf(spec: PrivatePageSpec, key: string): { tokens: readonly PrivateTokenName[]; selector: string; absolute?: boolean } | null {
  if (Object.hasOwn(spec.styles, key)) return spec.styles[key]!;
  const match = UI_KEY.exec(key);
  if (!match) return null;
  const [, kind, tone, app, target] = match;
  const ui = Object.hasOwn(PRIVATE_BUYER_UI_STYLES, kind!) ? PRIVATE_BUYER_UI_STYLES[kind!]! : null;
  if (!ui || (tone && !ui.tones?.includes(tone as PrivateUiTone))) return null;
  if (target && !pageTargets(spec).includes(target)) return null;
  return { tokens: ui.tokens, selector: uiSelector(ui.kind, tone, app, target) };
}

function uiSelector(kind: string, tone: string | undefined, app: string | undefined, target: string | undefined): string {
  return [
    target ? `[data-buyer-ui-target="${target}"]` : "[data-buyer-ui-target]",
    ...(app ? [`[data-buyer-ui-app="${app}"]`] : []),
    `${kind}${tone ? `[data-tone="${tone}"]` : ""}`,
  ].join(" ");
}

function layoutHooks(nodes: readonly PrivateNode[], out: Set<string>): Set<string> {
  for (const node of nodes) {
    if (node.type !== "layout") continue;
    if (node.hook) out.add(node.hook);
    layoutHooks(node.children, out);
  }
  return out;
}

/** Points along a gradient as the browser paints it (sRGB interpolation): the ends and 31 between. */
function gradientPoints(from: string, to: string): string[] {
  const channels = (value: string) => [1, 3, 5].map((at) => Number.parseInt(value.slice(at, at + 2), 16));
  const [a, b] = [channels(from), channels(to)];
  return Array.from({ length: 33 }, (_, step) => `#${a.map((channel, index) => Math.round(channel + ((b[index]! - channel) * step) / 32).toString(16).padStart(2, "0")).join("")}`);
}

type Values = Partial<Record<PrivateTokenName, unknown>>;

/** Each page's tokens checked: names, values by type, then every pair of the page's colour table. */
export function privateTokenIssues(page: PrivatePageKey, tokens: PrivateTokens[PrivatePageKey], context: PrivateTokenContext): PrivateTokenIssue[] {
  return compilePrivateTokens(page, tokens, context).issues;
}

/** The CSS the host writes from a page's checked tokens ("" for none, or when they do not pass). */
export function privateTokenCss(page: PrivatePageKey, tokens: PrivateTokens[PrivatePageKey], context: PrivateTokenContext): string {
  const compiled = compilePrivateTokens(page, tokens, context);
  return compiled.issues.length > 0 ? "" : compiled.css;
}

/** Names and values checked by type: the valid tokens per key, and what is wrong with the rest. */
function validTokens(page: PrivatePageKey, tokens: NonNullable<PrivateTokens[PrivatePageKey]>, context: PrivateTokenContext): { valid: Record<string, Values>; issues: PrivateTokenIssue[] } {
  const spec: PrivatePageSpec = PRIVATE_PAGES[page];
  const issues: PrivateTokenIssue[] = [];
  const hooks = layoutHooks(context.layout, new Set());
  for (const nodes of Object.values(context.items)) layoutHooks(nodes, hooks);
  const valid: Record<string, Values> = {};
  for (const [target, values] of Object.entries(tokens)) {
    const base = ["privatePages", "tokens", page, target];
    // A page with no page of its own (the drawer) opens over public pages and takes their look.
    if (!Object.hasOwn(spec.styles, "page")) {
      issues.push({ path: base, reason: "unknown_style", message: `${page} takes no tokens: it opens over public pages and takes their look from the public stylesheet.` });
      continue;
    }
    const layout = target.startsWith("@");
    const allowed: readonly PrivateTokenName[] | undefined = layout
      ? (PRIVATE_HOOK_PATTERN.test(target.slice(1)) && hooks.has(target.slice(1)) ? PRIVATE_LAYOUT_TOKENS : undefined)
      : styleOf(spec, target)?.tokens;
    if (!allowed) {
      issues.push({ path: base, reason: "unknown_style", message: layout
        ? `${target}: no layout node of this page's arrangement has the hook ${target.slice(1)}.`
        : `${target} is not a style target of ${page}; it takes ${Object.keys(spec.styles).join(", ")} and ui.<kind>[.<tone>][@<app>][/<target>].` });
      continue;
    }
    valid[target] = {};
    for (const [token, value] of Object.entries(values ?? {})) {
      const name = token as PrivateTokenName;
      if (!allowed.includes(name)) {
        issues.push({ path: [...base, token], reason: "unknown_token", message: `${target} takes ${allowed.join(", ")}; not ${token}.` });
        continue;
      }
      const parsed = PRIVATE_TOKEN_SPECS[name].schema.safeParse(value);
      if (!parsed.success) {
        issues.push({ path: [...base, token], reason: "token_value", message: `${target} ${token}: ${parsed.error.issues[0]?.message ?? "not a value this token takes"}.` });
        continue;
      }
      valid[target]![name] = parsed.data;
    }
  }
  return { valid, issues };
}

/**
 * A page's tokens compiled: checked by name, type and bounds, its colour
 * table resolved per palette and every pair of it checked, then the CSS: the
 * table's rows, then each target's other tokens (sizes, spacing, type,
 * columns), every rule at token mode's specificity.
 */
export function compilePrivateTokens(page: PrivatePageKey, tokens: PrivateTokens[PrivatePageKey], context: PrivateTokenContext): { issues: PrivateTokenIssue[]; css: string; tables: PrivateTokenTable[] } {
  if (!tokens) return { issues: [], css: "", tables: [] };
  const keys = Object.keys(tokens).length;
  const apps = privateTokenApps(tokens).length;
  if (keys > PRIVATE_TOKEN_LIMITS.keys || apps > PRIVATE_TOKEN_LIMITS.apps) {
    return { issues: [{ path: ["privatePages", "tokens", page], reason: "too_large", message: `A page takes at most ${PRIVATE_TOKEN_LIMITS.keys} style keys naming at most ${PRIVATE_TOKEN_LIMITS.apps} apps; this one has ${keys} naming ${apps}.` }], css: "", tables: [] };
  }
  const { valid, issues } = validTokens(page, tokens, context);
  issues.push(...prominenceIssues(page, valid));
  issues.push(...buyerUiButtonProminenceIssues(page, valid, (by) => Object.hasOwn(PRIVATE_PAGES[page].styles, PRIVATE_UI_BUTTON_UNDER) ? declared(PRIVATE_PAGES[page], valid, PRIVATE_UI_BUTTON_UNDER, by).value : undefined));
  if (issues.length > 0) return { issues, css: "", tables: [] };
  const built = privateTokenTables(page, valid, context);
  if (built.issues.length > 0) return { issues: built.issues, css: "", tables: built.tables };
  const contrast = [...tableIssues(page, built.tables), ...prominenceContrastIssues(page, built.tables), ...chosenIssues(page, built.tables)];
  if (contrast.length > 0) return { issues: contrast, css: "", tables: built.tables };
  const unitHooks = new Set<string>();
  for (const nodes of Object.values(context.items)) layoutHooks(nodes, unitHooks);
  for (const hook of layoutHooks(context.layout, new Set())) unitHooks.delete(hook);
  return { issues: [], css: `${privateTableCss(built.tables)}${shapeCss(page, valid, unitHooks)}`, tables: built.tables };
}

/**
 * Each target's rank (private-anatomy.ts `outranks`) by size and weight: the
 * total over every other money row, the add-on's lines and its own label;
 * Place order over the store's other filled buttons; Confirm over Go back.
 * Each side is drawn at its own token, else at the token of the target whose
 * rules reach its element (`typeFrom`), else at the host's; checked where a
 * theme sets either side.
 */
/** A target's words' size or weight as declared: its own token, else the token of the target whose rules reach it (`typeFrom`), else the host's. */
function declared(spec: PrivatePageSpec, tokens: Record<string, Values>, name: string, by: "size" | "weight"): { value: number | undefined; set: string | undefined } {
  const own = (key: string) => tokens[key]?.[by] === undefined ? undefined : Number(tokens[key]![by]);
  const style = spec.styles[name];
  const set = own(name) !== undefined ? name : style?.typeFrom && own(style.typeFrom) !== undefined ? style.typeFrom : undefined;
  return { value: set ? own(set)! : by === "size" ? style?.hostSize : style?.hostWeight, set };
}

/** The app node keys with a size that may draw at one of `targets` (a key naming no target draws at every target). */
function appSizes(tokens: Record<string, Values>, targets: readonly string[]): Array<{ key: string; size: number }> {
  return Object.entries(tokens).flatMap(([key, values]) => {
    const match = UI_KEY.exec(key);
    return match && typeof values.size === "number" && (!match[4] || targets.includes(match[4])) ? [{ key, size: values.size }] : [];
  });
}

/** The largest size a target outranks (each outranked target's declared size, the apps' nodes where it draws them): its size is drawn at least at it. */
function sizeFloor(spec: PrivatePageSpec, tokens: Record<string, Values>, name: string): number {
  const outranks = spec.styles[name]?.outranks;
  if (!outranks) return 0;
  const sizes = [
    // (A target drawn at this one's own size, the total's label with none of its own, adds nothing.)
    ...Object.entries(outranks.over).filter(([, by]) => by.includes("size")).map(([other]) => declared(spec, tokens, other, "size")).map((size) => size.set === name ? 0 : size.value ?? 0),
    ...(outranks.apps ? appSizes(tokens, outranks.apps).map((entry) => entry.size) : []),
  ];
  let floor = 0;
  for (const size of sizes) floor = Math.max(floor, size);
  return floor;
}

function prominenceIssues(page: PrivatePageKey, tokens: Record<string, Values>): PrivateTokenIssue[] {
  const spec: PrivatePageSpec = PRIVATE_PAGES[page];
  const drawn = (name: string, by: "size" | "weight") => declared(spec, tokens, name, by);
  const issues: PrivateTokenIssue[] = [];
  // A figure an app draws where the target outranks its nodes is never larger than it.
  for (const [name, style] of Object.entries(spec.styles)) {
    const mine = drawn(name, "size").value;
    if (mine === undefined || !style.outranks?.apps) continue;
    for (const { key, size } of appSizes(tokens, style.outranks?.apps ?? [])) {
      if (size > mine) issues.push({ path: ["privatePages", "tokens", page, key], reason: "prominence", message: `${key} is drawn at ${size}px where ${name} is drawn at ${mine}px: ${style.outranks!.why}.` });
    }
  }
  for (const [name, style] of Object.entries(spec.styles)) {
    for (const [other, ranks] of Object.entries(style.outranks?.over ?? {})) {
      for (const by of ranks) {
        if (by === "contrast") continue;
        const [mine, theirs] = [drawn(name, by), drawn(other, by)];
        if ((!mine.set && !theirs.set) || mine.value === undefined || theirs.value === undefined || mine.value >= theirs.value) continue;
        const [at, unit] = [theirs.set ?? mine.set!, by === "size" ? "px" : ""];
        issues.push({ path: ["privatePages", "tokens", page, at], reason: "prominence", message: `${name} is drawn at ${by === "weight" ? "weight " : ""}${mine.value}${unit}, under ${other} at ${theirs.value}${unit}: ${style.outranks!.why}.` });
      }
    }
  }
  return issues;
}

/**
 * The chosen payment method is told from the others by its edge and its dot, both drawn in its card's link colour
 * (`has-[:checked]:border-primary`, the dot `text-primary`), where an unchosen card draws its border colour: per
 * palette the two are clearly apart: 3:1 (a mark's floor) or `PRIVATE_EDGE_FILL_DISTANCE` (a filled button's fill from what is around it).
 */
function chosenIssues(page: PrivatePageKey, tables: readonly PrivateTokenTable[]): PrivateTokenIssue[] {
  // Every row a choice is drawn on (private-anatomy.ts `chosen`: the account's cards): the chosen option's link-coloured
  // edge clearly apart from the others' border, in each palette.
  for (const [name, style] of Object.entries(PRIVATE_PAGES[page].styles as Readonly<Record<string, PrivateStyleSpec>>)) {
    if (!style.chosen) continue;
    for (const table of tables) for (const row of table.rows.filter((each) => each.key === name && each.from.link !== undefined && each.from.border !== undefined)) {
      const apart = storefrontThemeColorDistance(row.link, row.border);
      const ratio = storefrontThemeContrast(row.link, row.border);
      if (apart < PRIVATE_EDGE_FILL_DISTANCE && ratio < PRIVATE_MARK_CONTRAST_FLOOR) {
        return [{ path: ["privatePages", "tokens", page, row.from.link ?? row.from.border ?? name], reason: "contrast", message: `${name}: a chosen option's edge (${row.link}, its link colour) reads ${ratio.toFixed(2)}:1 and ${apart.toFixed(1)} apart from an unchosen one's border (${row.border}) in the ${table.palette.scheme} colours: a buyer tells which is chosen at ${PRIVATE_MARK_CONTRAST_FLOOR}:1 or ${PRIVATE_EDGE_FILL_DISTANCE} apart. Set link and border clearly apart.` }];
      }
    }
  }
  if (!Object.hasOwn(PRIVATE_PAGES[page].styles, "payment-method")) return [];
  for (const table of tables) {
    const card = ["payment-method", "payment", "page"].map((key) => table.rows.find((row) => row.key === key)).find(Boolean);
    if (!card) continue;
    const chosen = table.rows.find((row) => row.key === "payment-chosen") ?? card;
    const apart = storefrontThemeColorDistance(chosen.link, card.border);
    const ratio = storefrontThemeContrast(chosen.link, card.border);
    if (apart < PRIVATE_EDGE_FILL_DISTANCE && ratio < PRIVATE_MARK_CONTRAST_FLOOR) {
      return [{ path: ["privatePages", "tokens", page, card.key], reason: "contrast", message: `The chosen payment method's edge and dot (${chosen.link}, its link colour) read ${ratio.toFixed(2)}:1 and ${apart.toFixed(1)} apart from an unchosen one's border (${card.border}) in the ${table.palette.scheme} colours: a buyer tells which is chosen at ${PRIVATE_MARK_CONTRAST_FLOOR}:1 or ${PRIVATE_EDGE_FILL_DISTANCE} apart. Set link and border clearly apart.` }];
    }
  }
  return [];
}

/**
 * Each target's rank by how strongly its words read, per palette: the
 * weakest colour of its words (its own, its amounts') on its surface is never
 * under the strongest of the target it outranks (its own words, its amounts',
 * a discount's link colour). The total's words never read fainter than a row's.
 */
function prominenceContrastIssues(page: PrivatePageKey, tables: readonly PrivateTokenTable[]): PrivateTokenIssue[] {
  const spec: PrivatePageSpec = PRIVATE_PAGES[page];
  const issues: PrivateTokenIssue[] = [];
  const strength = (row: PrivateTokenRow, colour: string) => Math.min(...row.surface.map((back) => storefrontThemeContrast(colour, back)));
  for (const [name, style] of Object.entries(spec.styles)) {
    for (const [other, ranks] of Object.entries(style.outranks?.over ?? {})) {
      if (!ranks.includes("contrast")) continue;
      for (const table of tables) {
        const mine = table.rows.filter((row) => row.key === name).flatMap((row) => [row.ink, row.text].map((colour) => ({ row, colour, ratio: strength(row, colour) })));
        const theirs = table.rows.filter((row) => row.key === other).flatMap((row) => [row.ink, row.text, row.link].map((colour) => ({ row, colour, ratio: strength(row, colour) })));
        if (mine.length === 0 || theirs.length === 0) continue;
        const weakest = mine.reduce((a, b) => (b.ratio < a.ratio ? b : a));
        const strongest = theirs.reduce((a, b) => (b.ratio > a.ratio ? b : a));
        if (weakest.ratio >= strongest.ratio) continue;
        const at = weakest.row.from[weakest.row.inkCell] ?? weakest.row.from.text ?? strongest.row.from[strongest.row.inkCell] ?? strongest.row.from.text ?? weakest.row.from.surface ?? name;
        issues.push({ path: ["privatePages", "tokens", page, at], reason: "prominence", message: `${name} reads ${weakest.colour} at ${weakest.ratio.toFixed(2)}:1, under ${other} (${strongest.colour}) at ${strongest.ratio.toFixed(2)}:1 in the ${table.palette.scheme} colours: ${style.outranks!.why}.` });
      }
    }
  }
  return issues;
}

// ─── The colour table ─────────────────────────────────────────────────────

/** The colours of a row, each a cell the CSS writes and the check reads. */
export const PRIVATE_ROW_COLOURS = ["text", "muted", "link", "error", "border", "ring", "placeholder", "invalid", "hover"] as const;
export type PrivateRowColour = (typeof PRIVATE_ROW_COLOURS)[number];

/** One row of the colour table: a style target at one place on the page, every colour it draws resolved for one palette. */
export interface PrivateTokenRow {
  /** Its style target (`summary`, `@line-grid`, `ui.badge.warning/cart.line.after`, `ui.banner@acme.protection/cart.page.summary`). */
  key: string;
  /** The theme's token key the row reads (an app node's row reads several, most specific last). */
  sources: string[];
  selector: string;
  kind: PrivateStyleKind;
  /** The rows beneath it: one, or (a field or button the host draws anywhere) every box of the page. */
  parents: string[];
  /** Its element sits inside its one parent's, so it inherits that row's cells: the CSS writes only those that differ. */
  nested: boolean;
  /** A row written before it whose selector reaches every element this one does: with the same cells, this one is not written again. */
  base: string | null;
  /** What it paints: a solid colour (and a gradient over it); null paints nothing, the row beneath shows. */
  paint: string | null;
  gradient: string | null;
  /** The colours beneath its words: one, or a gradient's points. */
  surface: string[];
  /** The colour of its own words: one of text, muted, link and error (`inkCell`). */
  ink: string;
  inkCell: "text" | "muted" | "link" | "error";
  text: string;
  muted: string;
  link: string;
  error: string;
  border: string;
  ring: string;
  /** What a control the host gives a hover paints under the pointer: visibly not its surface, its words still readable on it. */
  hover: string;
  /** A field's (and the page's, where every field reads it first) placeholder and error border. */
  placeholder: string | null;
  invalid: string | null;
  /**
   * How a buyer tells it from what is around it (private-anatomy.ts
   * `boundary`; every field `edge`), and whether it draws its border (no
   * `border-width: 0`, no `border-style: none`): an edge that draws none is
   * told by its fill. A filled button is `edge` where it is found by a drawn
   * edge (a solid border of at least PRIVATE_EDGE_MIN_WIDTH reading 3:1 on
   * every point around it, its fill at least PRIVATE_EDGE_FILL_DISTANCE from
   * each): its border is then checked, never its fill.
   */
  boundary: "fill" | "edge" | null;
  bordered: boolean;
  /**
   * A filled button found by its fill on some of what is around it and by its drawn edge on the rest (a yellow
   * button with a dark edge on a light card and in a dark dialog): the surfaces around it where its edge finds it.
   * Absent where one way finds it everywhere (its boundary says which).
   */
  edgeOn?: string[];
  /** Its words are a graphic's marks (a rating's stars): its text and muted colours read at 3:1, not 4.5:1. */
  graphic?: true;
  /** The theme key that set each cell, for a refusal's path. */
  from: Partial<Record<PrivateRowColour | "surface", string>>;
  /**
   * The cells it writes as colours, the rest read from the row it stands on
   * (an app's node, a label: `Place.writes`); null: every cell, those its
   * parent's element gives it left out (private-anatomy's parts).
   */
  writes: PrivateRowColour[] | null;
  /**
   * An app's node kind's row at a set of targets (its selector the page root,
   * the targets' mount, then `rest`): where every target's row of it writes
   * the same, the CSS writes one rule for them all.
   */
  share?: { id: string; targets: readonly string[]; rest: string };
}

export interface PrivateTokenTable {
  palette: PrivatePalette;
  rows: PrivateTokenRow[];
}

/** A pair the check reads: a colour of a row over a surface it is drawn on, and the floor it must reach. */
export interface PrivateTokenPair {
  key: string;
  /** A cell, or `fill`: a filled button's or a borderless edge's own surface on what is around it. */
  what: PrivateRowColour | "fill";
  fore: string;
  back: string;
  /** 4.5 for words, 3 for a field's marks, a focus ring and a control's or field's boundary, 1 for a box's border (it carries no meaning). */
  floor: number;
}

const ROLE_CELL: Partial<Record<PrivatePaletteRole, "text" | "muted" | "link" | "error">> = { "muted-foreground": "muted", primary: "link", destructive: "error" };
const cellOf = (role: PrivatePaletteRole) => ROLE_CELL[role] ?? "text";

/** The first colour that reads at `floor` on every one of `backs`: the candidates, black or white, then a grey; else the best there is. */
function readable(candidates: ReadonlyArray<string | null | undefined>, backs: readonly string[], floor: number): string {
  // A loop, never a spread: a row may stand on many surfaces.
  const worst = (colour: string) => {
    let least = Number.POSITIVE_INFINITY;
    for (const back of backs) least = Math.min(least, storefrontThemeContrast(colour, back));
    return least;
  };
  for (const colour of [...candidates, "#000000", "#ffffff"]) if (colour && worst(colour) >= floor) return colour;
  let best = "#000000";
  let bestRatio = 0;
  for (let level = 0; level <= 255; level += 1) {
    const grey = `#${level.toString(16).padStart(2, "0").repeat(3)}`;
    const ratio = worst(grey);
    if (ratio >= floor) return grey;
    if (ratio > bestRatio) { best = grey; bestRatio = ratio; }
  }
  return best;
}

/** One row as the walk places it, before its colours are resolved. */
interface Place {
  key: string;
  selector: string;
  kind: PrivateStyleKind;
  surface: PrivateStyleSpec["surface"];
  ink: PrivatePaletteRole;
  /** The row beneath it, or `boxes`: every box of the page. */
  parent: string | "boxes" | null;
  /** Its element sits inside its parent's element, so it inherits the parent's cells (not a dialog, not the store's chrome). */
  nested: boolean;
  /** A row whose selector reaches every element this one does, always written before it (an app node kind's row with no tone). */
  base: string | null;
  /** The theme keys it reads, least specific first. */
  sources: string[];
  /** Other rows it may stand on (an app's painted boxes where a field is drawn): its marks read on each. */
  more?: string[];
  /**
   * An app's node (`box`: one that holds others; `leaf`) or a label drawn
   * wherever fields are: it writes only what the theme set for it (and, where
   * it paints, what reads on its paint) and reads every other colour from the
   * row it stands on, so its rule is right in any box at any depth.
   */
  writes?: "box" | "leaf";
  /** An app's node row at its targets: its selector is the page root, these targets' mount, then `rest`. */
  share?: PrivateTokenRow["share"];
  /** private-anatomy.ts `boundary` (a field's row: `edge`). */
  boundary?: "fill" | "edge";
  /** private-anatomy.ts `bare`: a box of words only, never one a control drawn anywhere stands on. */
  bare?: true;
  /** private-anatomy.ts `graphic`: its words are marks, read at 3:1. */
  graphic?: true;
  /** private-anatomy.ts `chosen`: a choice is drawn on it, its link and border apart. */
  chosen?: true;
}

/** Every row of the page as the arrangement places it, in the order the CSS writes them (an inner row after the rows it can share an element with). */
function placesOf(spec: PrivatePageSpec, tokens: Record<string, Values>, context: PrivateTokenContext, kinds: Readonly<Record<string, PrivateBuyerUiStyle>>): Place[] {
  const root = `[data-private="${spec.root}"]`;
  const places: Place[] = [];
  const styles = Object.entries(spec.styles);
  const selectorOf = (style: PrivateStyleSpec) => style.absolute ? style.selector : style.selector ? `${root} ${style.selector}` : root;
  const place = (key: string, style: PrivateStyleSpec, parent: Place["parent"]) => {
    // A box that holds fields (a card, a conversation with its reply form) is a box a field row stands in.
    if (style.fields) holders.add(key);
    places.push({ key, selector: selectorOf(style), kind: style.kind, surface: style.surface, ink: style.ink, parent, nested: parent !== "boxes" && parent !== null && !style.absolute, base: null, sources: [key], ...(style.boundary ? { boundary: style.boundary } : {}), ...(style.bare ? { bare: true as const } : {}), ...(style.chosen ? { chosen: true as const } : {}) });
  };
  // The rows that hold fields: a part that draws them (on its box, else on what it sits on), a dialog, an app's target.
  const holders = new Set<string>();
  // Per row an app's target stands on, the app's boxes there that paint a surface of their own: a field or a label
  // drawn in an app's block may stand on any of them.
  const painted = new Map<string, string[]>();
  /** The targets inside `key`'s element, its apps' targets and (`variant`: of its part) what stands beside its box instead. */
  const inside = (key: string, variant?: string, beside?: string) => {
    // The apps' targets the host draws inside this target's element (the details form's) stand on its row.
    const targets = spec.styles[key]?.targets ?? [];
    if (targets.length > 0) ui(targets, key);
    for (const [name, style] of styles) {
      if (style.on !== key || style.absolute) continue;
      // Under this variant of its part, its element sits outside the part's box, on what the part stands on.
      const out = beside !== undefined && variant !== undefined && style.outside?.includes(variant) === true;
      place(name, style, out ? beside! : key);
      // What it holds keeps its part's variant: a box inside it may stand beside the part's box too (the chosen
      // payment method's details under tiles).
      inside(name, variant, beside);
      if (spec.items[name]) walk(context.items[name] ?? spec.items[name]!.layout, name, name);
    }
  };
  /**
   * The rows of every app node kind and tone at targets on one row: one set
   * for targets sharing a row that the theme names none of (their selectors
   * joined), else a set per target. Then, inside each of them that holds
   * other nodes on a surface it paints (`container`), a row for every other
   * kind and tone (`<inner> in <container>`): what an app draws in an amber
   * box is checked on the amber box. Those rows write no CSS of their own:
   * an app's node writes only what the theme set for it and reads the rest
   * from the row it stands on (`writes`), so its rule is the same in every
   * box at any depth.
   */
  const ui = (targets: readonly string[], parent: string): void => {
    holders.add(parent);
    if (targets.length > 1 && Object.keys(tokens).some((key) => targets.some((target) => UI_KEY.exec(key)?.[4] === target))) {
      for (const target of targets) ui([target], parent);
      return;
    }
    const target = targets.join("+");
    const mount = targets.length > 1 ? `:is(${targets.map((each) => `[data-buyer-ui-target="${each}"]`).join(",")})` : `[data-buyer-ui-target="${target}"]`;
    const apps = new Map<string, Set<string>>();
    for (const key of Object.keys(tokens)) {
      const match = UI_KEY.exec(key);
      if (match?.[3] && (!match[4] || match[4] === target)) apps.set(match[1]!, (apps.get(match[1]!) ?? new Set()).add(match[3]));
    }
    const made: Array<{ place: Place; name: string; style: PrivateBuyerUiStyle; tone: string | undefined; app: string | undefined }> = [];
    // Every kind and tone first, then the apps the theme names (an app's rows win over the generic ones).
    for (const app of [undefined, ...new Set([...apps.values()].flatMap((set) => [...set]))]) {
      for (const [kind, style] of Object.entries(kinds)) {
        if (!style.style || (app && !apps.get(kind)?.has(app))) continue;
        for (const tone of [undefined, ...style.tones ?? []]) {
          const scope = (narrow: string) => [`ui.${kind}${narrow}`, `ui.${kind}${narrow}/${target}`];
          const sources = [...scope(""), ...(tone ? scope(`.${tone}`) : []), ...(app ? [...scope(`@${app}`), ...(tone ? scope(`.${tone}@${app}`) : [])] : [])];
          const rest = uiSelector(style.kind, tone, app, target).slice(`[data-buyer-ui-target="${target}"]`.length);
          const id = `ui.${kind}${tone ? `.${tone}` : ""}${app ? `@${app}` : ""}`;
          const row: Place = {
            key: `${id}/${target}`, share: { id, targets, rest },
            selector: `${root} ${mount}${rest}`,
            kind: style.style, surface: "under", ink: (tone && style.toneInk?.[tone]) || style.ink || "foreground", parent, nested: true,
            // A tone row adds nothing where it writes what its kind's row (always written just before) writes.
            base: tone ? `ui.${kind}${app ? `@${app}` : ""}/${target}` : null, sources, writes: style.container ? "box" : "leaf",
          };
          places.push(row);
          made.push({ place: row, name: kind, style, tone, app });
        }
      }
    }
    const paints = (sources: readonly string[]) => sources.some((source) => tokens[source]?.background !== undefined || tokens[source]?.gradient !== undefined);
    const node = (style: PrivateBuyerUiStyle, tone: string | undefined) => `${style.kind}${tone ? `[data-tone="${tone}"]` : ""}`;
    for (const box of made) {
      if (!box.style.container || !paints(box.place.sources)) continue;
      painted.set(parent, [...painted.get(parent) ?? [], box.place.key]);
      for (const inner of made) {
        // Only the kinds it can hold (a banner holds its buttons), and only an app's own nodes in an app's box.
        const holds = (box.style as { readonly holds?: readonly string[] }).holds;
        if (inner === box || (holds && !holds.includes(inner.name)) || (inner.app && box.app && inner.app !== box.app)) continue;
        const app = inner.app ?? box.app;
        places.push({
          ...inner.place, key: `${inner.place.key} in ${box.place.key}`, parent: box.place.key, base: inner.place.key, share: undefined,
          selector: `${root} ${mount}${app ? ` [data-buyer-ui-app="${app}"]` : ""} ${node(box.style, box.tone)} ${node(inner.style, inner.tone)}`,
        });
      }
    }
  };
  function walk(nodes: readonly PrivateNode[], parent: string, item: string | undefined) {
    for (const node of nodes) {
      if (node.type === "layout") {
        let here = parent;
        const hookTokens = node.hook ? tokens[`@${node.hook}`] : undefined;
        if (node.hook && hookTokens && Object.keys(hookTokens).some((token) => (PRIVATE_COLOUR_TOKENS as readonly string[]).includes(token))) {
          places.push({ key: `@${node.hook}`, selector: `${root} [data-layout][data-hook="${node.hook}"]`, kind: "box", surface: "under", ink: "foreground", parent, nested: true, base: null, sources: [`@${node.hook}`] });
          here = `@${node.hook}`;
        }
        for (const [name, style] of styles) if (style.layout === node.layout && !item) place(name, style, here);
        walk(node.children, here, item);
      } else if (node.type === "part") {
        let box: string | null = null;
        const unit: PrivateUnitSpec | undefined = item ? spec.items[item] : spec;
        const variant = node.variant ?? unit?.parts[node.part]?.variants?.[0];
        for (const [name, style] of styles) {
          if (style.part !== node.part || style.item !== item) continue;
          place(name, style, parent);
          if (style.kind === "box") box ??= name;
          inside(name, variant, parent);
        }
        if (unit?.parts[node.part]?.fields) holders.add(box ?? parent);
      } else if (node.type === "target") {
        ui([node.target], parent);
      }
    }
  }
  // The page itself (`page`, the body) is the row everything else sits on.
  const pageKey = "page";
  place(pageKey, spec.styles[pageKey]!, null);
  // The page's frame, then the fields and buttons drawn anywhere, then the arrangement, then the dialogs and the store's chrome with its controls.
  for (const [name, style] of styles) if (style.on === pageKey && !style.absolute) place(name, style, pageKey);
  for (const [name, style] of styles) if (!style.on && !style.part && !style.item && !style.layout && !style.element && !style.within && name !== pageKey) place(name, style, "boxes");
  const frame = places[1]?.key ?? pageKey;
  walk(context.layout, frame, undefined);
  for (const [name, style] of styles) {
    if (!style.absolute || style.on !== pageKey) continue;
    place(name, style, pageKey);
    if (style.fields) holders.add(name);
    for (const [child, inner] of styles) {
      if (inner.on !== name) continue;
      place(child, inner, name);
      // The store's market and language forms hold fields: a field row stands on their row.
      if (inner.fields) holders.add(child);
    }
  }
  // A field style's rows, one in each box that holds fields, outer before inner (a field takes its nearest box's
  // row): its marks are checked on the box it is drawn on (and any app box there that paints), never on every box.
  // Its words (a label's) read the row it stands on unless the theme sets them (`writes`).
  const byKey = new Map(places.map((each) => [each.key, each]));
  const depth = (key: string): number => { const parent = byKey.get(key)?.parent; return typeof parent === "string" && parent !== "boxes" ? 1 + depth(parent) : 0; };
  for (const [name, style] of styles) {
    if (!style.element) continue;
    for (const holder of [...holders].sort((a, b) => depth(a) - depth(b))) {
      places.push({
        key: `${name}/${holder}`, selector: `${byKey.get(holder)!.selector} ${style.element}`, kind: style.kind, surface: style.surface, ink: style.ink, parent: holder, nested: true, base: null, sources: [name],
        ...(painted.has(holder) ? { more: painted.get(holder)! } : {}), ...(style.kind === "text" ? { writes: "leaf" as const } : {}),
      });
    }
  }
  // A style drawn in named boxes wherever the page draws it (a rating): a row in each, outer before inner.
  for (const [name, style] of styles) {
    if (!style.within) continue;
    for (const holder of style.within.filter((key) => byKey.has(key)).sort((a, b) => depth(a) - depth(b))) {
      places.push({
        key: `${name}/${holder}`, selector: `${byKey.get(holder)!.selector} ${style.selector}`, kind: style.kind, surface: style.surface, ink: style.ink, parent: holder, nested: true, base: null, sources: [name],
        ...(style.graphic ? { graphic: true as const } : {}),
      });
    }
  }
  return places;
}

/** The theme's tokens a row reads, merged least specific first, with the key that set each. */
function merged(tokens: Record<string, Values>, sources: readonly string[]): { values: Values; from: Partial<Record<PrivateTokenName, string>> } {
  const values: Values = {};
  const from: Partial<Record<PrivateTokenName, string>> = {};
  for (const source of sources) {
    for (const [name, value] of Object.entries(tokens[source] ?? {})) {
      values[name as PrivateTokenName] = value;
      from[name as PrivateTokenName] = source;
    }
  }
  return { values, from };
}

/**
 * A row that writes only what the theme set (an app's node, a label): every
 * other cell is the row beneath's, which its element inherits (its focus
 * ring always, its words and hover where it paints nothing). Where it paints,
 * it writes the words that read on its paint and their hover (a box all its
 * cells: what it holds reads them).
 */
function readsBeneath(row: PrivateTokenRow, writes: "box" | "leaf", cell: "text" | "muted" | "link" | "error", parent: PrivateTokenRow | null, paints: boolean): PrivateTokenRow {
  const set = (name: PrivateRowColour) => row.from[name] !== undefined;
  const own = new Set<PrivateRowColour>(PRIVATE_ROW_COLOURS.filter(set));
  if (paints) for (const name of writes === "box" ? ["text", "muted", "link", "error", "border", "ring", "hover"] as const : ["text", cell, "border", "hover"] as const) own.add(name);
  // A box that paints rings what it holds on its paint; anything else's ring is the one beneath's (it reads on that).
  if (!(paints && writes === "box") && !set("ring")) own.delete("ring");
  const next: PrivateTokenRow = { ...row, paint: paints ? row.paint : null, writes: PRIVATE_ROW_COLOURS.filter((name) => own.has(name)) };
  if (parent) {
    for (const name of ["text", "muted", "link", "error", "border", "ring", "hover"] as const) if (!own.has(name)) next[name] = parent[name];
    next.ink = next[cell];
  }
  return next;
}

/** One palette's rows, each resolved from the theme's tokens and the surface beneath. */
function resolveRows(places: readonly Place[], tokens: Record<string, Values>, palette: PrivatePalette): PrivateTokenRow[] {
  const colors = palette.colors;
  const hex = (value: unknown) => {
    const one = inScheme(value, palette.scheme);
    return HEX.test(String(one)) ? String(one) : colors[one as keyof StorefrontThemeColors];
  };
  const byKey = new Map<string, PrivateTokenRow>();
  // Every box of the page a store's control drawn anywhere may stand on, gathered once (the rows drawn anywhere are
  // resolved after all of them): never an app's box (an app draws its own buttons there, rows of their own), nor a
  // box of words only (a message, an add-on's lines: `bare`).
  const bare = new Set(places.filter((place) => place.bare).map((place) => place.key));
  let allBoxes: PrivateTokenRow[] | null = null;
  const boxes = () => (allBoxes ??= [...byKey.values()].filter((row) => row.kind === "box" && !row.key.startsWith("ui.") && !bare.has(row.key)));
  const resolve = (place: Place): PrivateTokenRow => {
    const { values, from: set } = merged(tokens, place.sources);
    const parents = place.parent === "boxes" ? boxes() : place.parent ? [place.parent, ...place.more ?? []].map((key) => byKey.get(key)!) : [];
    const parent = parents.length === 1 ? parents[0]! : null;
    const from: PrivateTokenRow["from"] = {};
    let paint: string | null;
    let gradient: string | null = null;
    let surface: string[];
    const fill = values.gradient as Gradient | undefined;
    if (fill) {
      const [start, end] = [hex(fill.from), hex(fill.to)];
      gradient = fill.shape === "linear" ? `linear-gradient(${fill.angle ?? 180}deg,${start},${end})` : `radial-gradient(circle at top,${start},${end})`;
      surface = gradientPoints(start, end);
      paint = start;
      from.surface = set.gradient;
    } else if (values.background) {
      paint = hex(values.background);
      surface = [paint];
      from.surface = set.background;
    } else if ((place.surface === "under-hover" || place.surface === "under-link") && parent) {
      // A surface taken from the row it sits in (a message from its conversation): the page's own look, never the palette's.
      paint = place.surface === "under-hover" ? parent.hover : parent.link;
      surface = [paint];
    } else if (place.surface === "under") {
      // On every row it may stand on.
      surface = parents.length === 1 ? parents[0]!.surface : parents.length > 1 ? [...new Set(parents.flatMap((row) => row.surface))] : [colors.background];
      paint = surface.length === 1 && !place.writes ? surface[0]! : null;
      from.surface = parents.map((row) => row.from.surface).find(Boolean);
    } else if (place.parent === null && palette.pagePaint) {
      // The page row with no surface token stands on the theme's page paint, in this palette's colours.
      surface = storefrontPagePaintColors(palette.pagePaint, colors);
      paint = surface[0]!;
      gradient = palette.pagePaint.kind === "color" ? null : storefrontPagePaintCss(palette.pagePaint, (key) => colors[key]);
    } else if (place.boundary === "fill") {
      // A filled button the theme leaves at its palette's fill: that fill where it reads on what is around it, else
      // the palette's inverse (its words' colour), else black or white, so a dark dialog's Confirm is still a button.
      paint = readable([colors[place.surface as PrivatePaletteRole], colors[place.ink]], parents.flatMap((row) => row.surface), PRIVATE_MARK_CONTRAST_FLOOR);
      surface = [paint];
    } else {
      paint = colors[place.surface as PrivatePaletteRole];
      surface = [paint];
    }
    // A row with no surface of its own reads first what the row beneath reads on that same surface.
    const under = (place.surface === "under" || place.surface === "under-hover" || place.surface === "under-link") && !fill && !values.background ? parent : null;
    const cell = cellOf(place.ink);
    const take = (name: PrivateRowColour, token: PrivateTokenName | null, candidates: ReadonlyArray<string | null | undefined>, backs: readonly string[], floor: number) => {
      const value = token ? values[token] : undefined;
      if (value !== undefined) {
        from[name] = set[token!];
        return hex(value);
      }
      return readable(candidates, backs, floor);
    };
    const own = (name: "text" | "muted" | "link" | "error") => (cell === name ? "text" : name === "text" ? null : name) as PrivateTokenName | null;
    // A graphic's marks (a rating's stars) read at 3:1: its colour the rating amber, else that amber toward the page's words.
    const wordFloor = place.graphic ? PRIVATE_MARK_CONTRAST_FLOOR : PRIVATE_CONTRAST_FLOOR;
    const text = take("text", own("text"), place.graphic
      ? [STOREFRONT_RATING_COLOR, ...[0.2, 0.35, 0.5, 0.65].map((weight) => storefrontThemeMix(STOREFRONT_RATING_COLOR, parent?.text ?? colors.foreground, weight))]
      : [under?.text, colors[cell === "text" ? place.ink : "foreground"], colors.foreground, colors.background], surface, wordFloor);
    const muted = take("muted", own("muted"), [under?.muted, colors["muted-foreground"], text], surface, wordFloor);
    // A choice's row (`chosen`): the chosen option's edge (its link) and the others' (its border) clearly apart. A default
    // is found apart from what the theme set (or from the other default); only a pair the theme set both of is refused.
    const apart = (a: string, b: string) => storefrontThemeContrast(a, b) >= PRIVATE_MARK_CONTRAST_FLOOR || storefrontThemeColorDistance(a, b) >= PRIVATE_EDGE_FILL_DISTANCE;
    const chosenBorder = place.chosen && values.border !== undefined ? hex(values.border) : null;
    const linkCandidates = [under?.link, colors.primary, text, colors.foreground, "#1d4ed8", "#93c5fd", "#000000", "#ffffff"];
    const link = take("link", own("link"), chosenBorder ? linkCandidates.filter((colour) => colour && apart(colour, chosenBorder)) : linkCandidates.slice(0, 3), surface, PRIVATE_CONTRAST_FLOOR);
    const error = take("error", own("error"), [under?.error, colors.destructive, text], surface, PRIVATE_CONTRAST_FLOOR);
    // What a field's marks and a control's focus ring are drawn on: the rows beneath (a page's own surface).
    const around = parents.length > 0 ? parents.flatMap((row) => row.surface) : surface;
    const marked = place.kind === "field" || place.kind === "control";
    // A control's or a field's own ring is drawn outside it; a box's rings are its children's, drawn on it.
    const ring = take("ring", "ring", [under?.ring, storefrontThemeFocusRing(colors), text, colors.foreground, colors.background], marked ? around : surface, PRIVATE_MARK_CONTRAST_FLOOR);
    // A field's and an outlined control's border is how a buyer finds it: it reads on what is around it.
    const edgeBorder = () => take("border", "border", [colors.input, colors.border, muted, text], around, PRIVATE_MARK_CONTRAST_FLOOR);
    // A filled button is found, on each surface around it, by its fill where that reads there, else by a drawn edge:
    // a solid border the theme sets at least PRIVATE_EDGE_MIN_WIDTH wide, reading on that surface, over a fill still
    // clearly a colour of its own there. Found by its edge everywhere, it is an edge; on some surfaces only, its fill
    // is read on the rest (`edgeOn`).
    const width = values["border-width"];
    const solidEdge = place.boundary === "fill" && typeof width === "number" && width >= PRIVATE_EDGE_MIN_WIDTH && (values["border-style"] ?? "solid") === "solid";
    const drawnEdge = solidEdge ? edgeBorder() : null;
    const edgeOn = drawnEdge === null ? [] : [...new Set(around)].filter((back) => !surface.every((point) => storefrontThemeContrast(point, back) >= PRIVATE_MARK_CONTRAST_FLOOR)
      && storefrontThemeContrast(drawnEdge, back) >= PRIVATE_MARK_CONTRAST_FLOOR && surface.every((point) => storefrontThemeColorDistance(point, back) >= PRIVATE_EDGE_FILL_DISTANCE));
    const edged = edgeOn.length > 0 && edgeOn.length === new Set(around).size;
    const boundary = place.kind === "field" || edged ? "edge" : place.boundary ?? null;
    const border = boundary === "edge" ? edgeBorder() : drawnEdge ?? take("border", "border", place.chosen
      ? [under?.border, colors.border, colors.input, muted, text, "#000000", "#ffffff"].filter((colour) => colour && apart(colour, link))
      : [under?.border ?? colors.border], surface, 1);
    const field = place.kind === "field" || place.parent === null;
    const placeholder = field ? take("placeholder", "placeholder", [colors["muted-foreground"], muted, text], surface, PRIVATE_CONTRAST_FLOOR) : null;
    const invalid = field ? take("invalid", "invalid", [colors.destructive, error, text], around, PRIVATE_MARK_CONTRAST_FLOOR) : null;
    const cells = { text, muted, link, error };
    const row: PrivateTokenRow = {
      key: place.key, sources: place.sources, selector: place.selector, kind: place.kind, parents: parents.map((each) => each.key), nested: place.nested, base: place.base,
      paint, gradient, surface, ink: cells[cell], inkCell: cell, text, muted, link, error, border, ring, hover: storefrontThemeHoverSurface(paint !== null && !gradient ? [paint] : surface, [text, cells[cell], ...(place.kind === "box" && !place.writes ? [muted, link] : [])]), placeholder, invalid,
      boundary, bordered: values["border-width"] !== 0 && values["border-style"] !== "none", ...(boundary === "fill" && edgeOn.length > 0 ? { edgeOn } : {}), from,
      writes: null, ...(place.share ? { share: place.share } : {}), ...(place.graphic ? { graphic: true as const } : {}),
    };
    return place.writes ? readsBeneath(row, place.writes, cell, parent, Boolean(fill || values.background)) : row;
  };
  // Rows drawn anywhere are resolved last (they are checked on every box), but written where they stand.
  const resolved = new Map<Place, PrivateTokenRow>();
  for (const place of places) if (place.parent !== "boxes") { const row = resolve(place); resolved.set(place, row); byKey.set(row.key, row); }
  for (const place of places) if (place.parent === "boxes") resolved.set(place, resolve(place));
  return places.map((place) => resolved.get(place)!);
}

/**
 * The page's colour table, one per palette buyers can see: every style
 * target at every place the arrangement puts it. A target the page draws
 * with no row is refused (`no_row`): the check could not read it.
 */
export function privateTokenTables(
  page: PrivatePageKey, tokens: Record<string, Values>, context: PrivateTokenContext, spec: PrivatePageSpec = PRIVATE_PAGES[page], kinds: Readonly<Record<string, PrivateBuyerUiStyle>> = PRIVATE_BUYER_UI_STYLES,
): { tables: PrivateTokenTable[]; issues: PrivateTokenIssue[] } {
  const places = placesOf(spec, tokens, context, kinds);
  // Planned before any row is resolved: a table over the bound is refused at no further cost.
  if (places.length > PRIVATE_TOKEN_LIMITS.rows) {
    return { tables: [], issues: [{ path: ["privatePages", "tokens", page], reason: "too_large", message: `These tokens make ${places.length} rows of the page's colour table, over the ${PRIVATE_TOKEN_LIMITS.rows} a page holds: name fewer apps, targets or toned kinds.` }] };
  }
  const issues: PrivateTokenIssue[] = [];
  const keys = new Set(places.map((place) => place.key));
  const layouts = new Set<string>();
  const collect = (nodes: readonly PrivateNode[]) => { for (const node of nodes) if (node.type === "layout") { layouts.add(node.layout); collect(node.children); } };
  collect(context.layout);
  for (const [name, style] of Object.entries(spec.styles)) {
    // A target only a host layout draws (the fold's bar) has no row where the arrangement has no such layout;
    // a field style's rows are its holders' (`input/details-form`).
    if (keys.has(name) || ((style.element || style.within) && [...keys].some((key) => key.startsWith(`${name}/`))) || (style.layout && !layouts.has(style.layout))) continue;
    issues.push({ path: ["privatePages", "tokens", page, name], reason: "no_row", message: `${name}: the page draws it but its colour table has no row for it, so its colours could not be checked.` });
  }
  return { tables: context.palettes.map((palette) => ({ palette, rows: resolveRows(places, tokens, palette) })), issues };
}

/** Every pair a row draws: its words on its surface, a field's marks and a control's own focus ring on what is around it, a box's border and its children's rings on its own surface. */
export function privateTablePairs(table: PrivateTokenTable): PrivateTokenPair[] {
  const byKey = new Map(table.rows.map((row) => [row.key, row]));
  const pairs: PrivateTokenPair[] = [];
  for (const row of table.rows) {
    const around = row.parents.length > 0 ? row.parents.flatMap((key) => byKey.get(key)!.surface) : row.surface;
    const marked = row.kind === "field" || row.kind === "control";
    // A row that writes only some cells is checked on those: the rest are the row beneath's, checked there.
    const add = (what: PrivateRowColour, fore: string | null, backs: readonly string[], floor: number) => {
      if (fore && (!row.writes || row.writes.includes(what))) for (const back of new Set(backs)) pairs.push({ key: row.key, what, fore, back, floor });
    };
    // A graphic's marks (a rating's filled and empty stars) read at 3:1 (WCAG 1.4.11), words at 4.5:1.
    for (const what of ["text", "muted", "link", "error", "placeholder"] as const) add(what, row[what], row.surface, row.graphic && (what === "text" || what === "muted") ? PRIVATE_MARK_CONTRAST_FLOOR : PRIVATE_CONTRAST_FLOOR);
    add("ring", row.ring, marked ? around : row.surface, PRIVATE_MARK_CONTRAST_FLOOR);
    // An edge is found by its border where it draws one, else by its own fill; a filled button by its fill, or
    // where it draws a solid edge of its own over a fill clearly apart, as an edge (WCAG 1.4.11): a pair the check
    // reads is a pair the CSS draws.
    if (row.boundary === "edge" && row.bordered) add("border", row.border, around, PRIVATE_MARK_CONTRAST_FLOOR);
    else if (row.edgeOn) add("border", row.border, row.edgeOn, PRIVATE_MARK_CONTRAST_FLOOR);
    else add("border", row.border, row.surface, 1);
    if (row.boundary === "fill" || (row.boundary === "edge" && !row.bordered)) {
      // A filled button found by its edge on some surfaces is read by its fill on the others.
      for (const fore of new Set(row.surface)) for (const back of new Set(around)) if (!row.edgeOn?.includes(back)) pairs.push({ key: row.key, what: "fill", fore, back, floor: PRIVATE_MARK_CONTRAST_FLOOR });
    }
    add("invalid", row.invalid, around, PRIVATE_MARK_CONTRAST_FLOOR);
    // A hovered control paints the hover surface under its words.
    // (A hover that is a point of the surface adds no pair: its words are checked on the surface.)
    // A row that writes only some cells and paints nothing hovers (a control: an app's button) on the hover of the row
    // it stands on: its words are checked there.
    // A graphic's marks paint no hover surface under them (a star the pointer is on takes the filled colour).
    const hovers = !row.graphic && (!row.writes || row.writes.includes("hover") || (row.kind === "control" && row.parents.length <= 1));
    // Every word colour the row draws reads on its hover surface too (a card that is a link: its muted and link words).
    if (!row.surface.includes(row.hover) && hovers) for (const word of new Set([row.text, row.ink, ...(row.kind === "box" && !row.writes ? [row.muted, row.link] : [])])) pairs.push({ key: row.key, what: "hover", fore: word, back: row.hover, floor: PRIVATE_CONTRAST_FLOOR });
  }
  return pairs;
}

/** Every pair of every palette's table under its floor, once each, at the theme key that set it. */
function tableIssues(page: PrivatePageKey, tables: readonly PrivateTokenTable[]): PrivateTokenIssue[] {
  const issues: PrivateTokenIssue[] = [];
  const seen = new Set<string>();
  for (const table of tables) {
    const byKey = new Map(table.rows.map((row) => [row.key, row]));
    for (const pair of privateTablePairs(table)) {
      const ratio = storefrontThemeContrast(pair.fore, pair.back);
      if (ratio >= pair.floor) continue;
      const row = byKey.get(pair.key)!;
      // A fill is the row's own (its surface token, else its own key: it set no border, or left its fill the host's).
      const target = pair.what === "fill"
        ? (row.from.surface && row.sources.includes(row.from.surface) ? row.from.surface : row.sources.at(-1) ?? row.key)
        : row.from[pair.what] ?? row.from.surface ?? row.parents.map((key) => byKey.get(key)?.from.surface).find(Boolean) ?? row.sources.at(-1) ?? row.key;
      // Once per theme key and pair: a field style's rows in several boxes refuse its one bad pair once.
      const id = `${target}|${pair.what}|${pair.fore}|${pair.back}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const where = pair.key === target ? target : `${target} (${pair.key})`;
      const what = pair.what === "fill" ? (row.boundary === "fill" ? "its fill" : "its fill, with no border drawn,") : pair.what;
      // A filled button refused by its fill may instead be found by a drawn edge: say so.
      const instead = pair.what !== "fill" ? "" : row.boundary === "fill"
        ? ` to find it: give it a fill that reads, or draw a solid border of at least ${PRIVATE_EDGE_MIN_WIDTH}px at ${PRIVATE_MARK_CONTRAST_FLOOR}:1 on it, with a fill clearly a colour of its own`
        : " to find it";
      issues.push({ path: ["privatePages", "tokens", page, target], reason: "contrast", message: `${where}: ${what} ${pair.fore} on ${pair.back} is ${ratio.toFixed(2)}:1 in the ${table.palette.scheme} colours, under the ${pair.floor}:1 a buyer needs${instead}.` });
    }
  }
  return issues;
}

const CELL_PROPERTIES = [["text", "--pt-t"], ["muted", "--pt-m"], ["link", "--pt-l"], ["error", "--pt-e"], ["border", "--pt-b"], ["ring", "--pt-r"], ["hover", "--pt-h"], ["placeholder", "--pt-p"], ["invalid", "--pt-i"]] as const;
const CELL_PROPERTY = /* @__PURE__ */ (() => Object.fromEntries(CELL_PROPERTIES))() as Record<PrivateRowColour, string>;

/**
 * A row's cells as declarations: its paint, its own words' colour and the
 * cells everything inside it reads (`--pt-*`). A nested box or text target's
 * element inherits its parent's cells and shows its parent's paint, so only
 * what differs is written (its own words' colour always). A control, a field
 * and an app's node write every cell: their element also meets another row
 * (Place order is a filled button, a badge has its kind's and its tone's
 * rows), whose cells it would read instead of its parent's. What another
 * palette's row of the same target writes (`also`), this one writes too: the
 * dark rows sit over the light ones on the same element, so a cell left out
 * there would read the light row's value.
 */
export function privateRowDeclarations(row: PrivateTokenRow, parent: PrivateTokenRow | null, also: ReadonlySet<string> = NONE): string {
  if (row.writes) return writtenDeclarations(row, row.writes);
  const inherited = row.nested && (row.kind === "box" || row.kind === "text") && !row.key.startsWith("ui.") ? parent : null;
  const paints = row.paint !== null && (also.has("background-color") || !(inherited && inherited.surface.length === 1 && inherited.paint === row.paint && !row.gradient));
  // Where no hover surface keeps every word readable (the hover is the surface), a hovered control is underlined instead.
  const hoverMark = (each: PrivateTokenRow) => (each.surface.includes(each.hover) ? "underline" : "none");
  const hoverDeclaration = hoverMark(row) !== (inherited ? hoverMark(inherited) : "none") || also.has("--pt-hd") ? `--pt-hd:${hoverMark(row)}` : "";
  return [
    paints ? `background-color:${row.paint}` : "",
    row.gradient ? `background-image:${row.gradient}` : "",
    `color:${row.ink}`,
    hoverDeclaration,
    row.kind === "field" ? `border-color:${row.border}` : "",
    ...CELL_PROPERTIES.map(([cell, property]) => row[cell] && (row[cell] !== inherited?.[cell] || also.has(property)) ? `${property}:${row[cell]}` : ""),
  ].filter(Boolean).join(";");
}

const NONE: ReadonlySet<string> = new Set();

/**
 * A row that writes only some cells (`writes`): its paint where it paints,
 * those cells, and its words' colour: its own cell's colour where it writes
 * that cell, else that cell of the row beneath (an app's node: the host's
 * rule `PRIVATE_TOKEN_MODE_CSS` says which cell each kind and tone reads).
 */
function writtenDeclarations(row: PrivateTokenRow, writes: readonly PrivateRowColour[]): string {
  // An app's node takes its words' colour from its own cell (`PRIVATE_TOKEN_MODE_CSS`), which it writes where the theme set it.
  const words = row.key.startsWith("ui.") ? "" : writes.includes(row.inkCell) ? `color:${row.ink}` : `color:var(${CELL_PROPERTY[row.inkCell]})`;
  return [
    row.paint !== null ? `background-color:${row.paint}` : "",
    row.gradient ? `background-image:${row.gradient}` : "",
    words,
    ...CELL_PROPERTIES.map(([cell, property]) => writes.includes(cell) && row[cell] ? `${property}:${row[cell]}` : ""),
  ].filter(Boolean).join(";");
}

/** Per target, the properties any palette's row of it writes: every palette's row writes them all. */
export function privateRowsWritten(tables: readonly PrivateTokenTable[]): Map<string, Set<string>> {
  const written = new Map<string, Set<string>>();
  for (const table of tables) {
    const byKey = new Map(table.rows.map((row) => [row.key, row]));
    for (const row of table.rows) {
      const set = written.get(row.key) ?? new Set<string>();
      for (const declaration of privateRowDeclarations(row, row.parents.length === 1 ? byKey.get(row.parents[0]!)! : null).split(";")) set.add(declaration.slice(0, declaration.indexOf(":")));
      written.set(row.key, set);
    }
  }
  return written;
}

/** One rule of the table's CSS: the rows it writes (their selectors) and their cells. */
export interface PrivateTableRule {
  keys: string[];
  selectors: string[];
  declarations: string;
}

/**
 * Each palette's rules, row by row in the table's order: a row with nothing
 * of its own is not written, nor one whose base row writes the same;
 * neighbours with the same cells share one rule; and an app node kind's rows
 * at every target, where each writes the same (no target's tokens differ),
 * are one rule at its first row, its mount every target's (an app's node
 * writes nothing that depends on where it stands, `Place.writes`). Rows of
 * one kind and tone reach only its own elements, and its rows come in the
 * same order at every target, so the one rule keeps every element's order.
 */
export function privateTableRules(tables: readonly PrivateTokenTable[]): PrivateTableRule[][] {
  const everywhere = privateRowsWritten(tables);
  return tables.map((table) => {
    const byKey = new Map(table.rows.map((row) => [row.key, row]));
    const written = new Map<string, string>();
    const kept: Array<{ row: PrivateTokenRow; declarations: string }> = [];
    for (const row of table.rows) {
      const declarations = privateRowDeclarations(row, row.parents.length === 1 ? byKey.get(row.parents[0]!)! : null, everywhere.get(row.key));
      written.set(row.key, declarations);
      // A row with nothing of its own to write (an app's node the theme leaves alone) reads all of it from beneath.
      if (declarations === "" || (row.base && written.get(row.base) === declarations)) continue;
      kept.push({ row, declarations });
    }
    // An app node kind's rows at the targets where every one of its kinds and tones (an app's too) writes the same:
    // one rule each for those targets, at the first of their rows, in the order its rows take at each target, so every
    // element meets its rules in its row order (a kind's rules reach only its own elements).
    const declared = new Map(kept.map((entry) => [entry.row.key, entry.declarations]));
    const groups = new Map<string, { kind: string; targets: string[]; rows: Map<string, PrivateTokenRow[]> }>();
    const signature = new Map<string, string>();
    for (const row of table.rows) {
      if (!row.share) continue;
      const kind = /^ui\.[a-z]+/.exec(row.share.id)![0];
      const at = `${kind}|${row.share.targets.join("+")}`;
      signature.set(at, `${signature.get(at) ?? ""}|${row.share.id}=${declared.get(row.key) ?? ""}`);
    }
    // Each signature as a short id, so grouping a row never builds a key the length of its group.
    const ids = new Map<string, number>();
    const groupKey = new Map<string, string>();
    for (const [at, text] of signature) {
      if (!ids.has(text)) ids.set(text, ids.size);
      groupKey.set(at, `${at.slice(0, at.indexOf("|"))}#${ids.get(text)}`);
    }
    const groupOf = (row: PrivateTokenRow) => groupKey.get(`${/^ui\.[a-z]+/.exec(row.share!.id)![0]}|${row.share!.targets.join("+")}`)!;
    for (const row of table.rows) {
      if (!row.share) continue;
      const id = groupOf(row);
      const group = groups.get(id) ?? { kind: "", targets: [], rows: new Map<string, PrivateTokenRow[]>() };
      if (!group.rows.has(row.share.id)) group.rows.set(row.share.id, []);
      group.rows.get(row.share.id)!.push(row);
      if (!group.targets.includes(row.share.targets.join("+"))) group.targets.push(row.share.targets.join("+"));
      groups.set(id, group);
    }
    const pageTargets = new Set(table.rows.flatMap((row) => row.share?.targets ?? []));
    const rules: PrivateTableRule[] = [];
    const push = (key: string, selector: string, declarations: string) => {
      const last = rules.at(-1);
      if (last?.declarations === declarations) { last.selectors.push(selector); last.keys.push(key); }
      else rules.push({ keys: [key], selectors: [selector], declarations });
    };
    const done = new Set<string>();
    for (const { row, declarations } of kept) {
      const group = row.share ? groups.get(groupOf(row))! : null;
      if (!row.share || !group || group.targets.length < 2) { push(row.key, row.selector, declarations); continue; }
      const id = groupOf(row);
      if (done.has(id)) continue;
      done.add(id);
      for (const rows of group.rows.values()) {
        const first = rows.find((each) => declared.has(each.key));
        if (!first) continue;
        const targets = rows.flatMap((each) => each.share!.targets);
        const mount = targets.length === pageTargets.size ? "[data-buyer-ui-target]" : `:is(${targets.map((target) => `[data-buyer-ui-target="${target}"]`).join(",")})`;
        push(first.key, `${first.selector.slice(0, first.selector.indexOf(" "))} ${mount}${first.share!.rest}`, declared.get(first.key)!);
      }
    }
    return rules;
  });
}

/**
 * The table as CSS (`privateTableRules`): the first palette as it is, a
 * second (dark) under the page's dark scheme, its rules nested in that one
 * scope (a browser that cannot nest draws the first palette's, whole). Every
 * token-mode rule has the specificity of `PRIVATE_TOKEN_MODE` alone, above
 * the store's own rules for these elements, so a later row wins where two
 * reach one element and the host's palette classes after them read the
 * row's cells.
 */
export function privateTableCss(tables: readonly PrivateTokenTable[]): string {
  return privateTableRules(tables).map((rules, index) => {
    const css = rules.map((rule) => `:where(${rule.selectors.join(",")}){${rule.declarations}}`);
    return index === 0 ? css.map((rule) => `${PRIVATE_TOKEN_MODE} ${rule}`).join("") : `@media screen{${PRIVATE_TOKEN_MODE}:where([data-color-scheme="dark"]){${css.join("")}}}`;
  }).join("");
}

/** The palettes a theme's buyers can see, each with the scheme it is drawn under. */
export function privatePalettes(theme: PrivatePalettesInput, dark: (colors: StorefrontThemeColors) => StorefrontThemeColors): PrivatePalette[] {
  const light = theme.colorScheme !== "dark" || theme.colorSchemeToggle;
  const showsDark = theme.colorScheme !== "light" || theme.colorSchemeToggle;
  const paint = theme.pagePaint ? { pagePaint: theme.pagePaint } : {};
  return [
    ...(light ? [{ scheme: "light" as const, colors: theme.colors, ...paint }] : []),
    ...(showsDark ? [{ scheme: "dark" as const, colors: theme.darkColors ?? dark(theme.colors), ...paint }] : []),
  ];
}

// ─── The rest of the look ─────────────────────────────────────────────────

/** The narrowest box a grid's tracks fit, each at least its floor, with the gaps: below it, the host's one column. */
function tracksFit(value: Tracks, gap: number, floor: number): number {
  return value.reduce<number>((sum, track) => sum + Math.max(floor, typeof track === "number" ? track : floor), 0) + gap * (value.length - 1);
}

/**
 * Each target's tokens that are not colours (sizes, spacing, type, columns)
 * as rules under the page root (or as the anatomy places it) at token mode's
 * specificity (`PRIVATE_TOKEN_MODE`, above every host rule but a theme's
 * region rules: a token the save accepts is drawn), in the anatomy's order, its wide values in the wide media query and a
 * grid's columns only where they fit. Values were checked by type: nothing
 * here is a theme's text.
 */
function shapeCss(page: PrivatePageKey, tokens: Record<string, Values>, unitHooks: ReadonlySet<string>): string {
  const spec: PrivatePageSpec = PRIVATE_PAGES[page];
  const root = `[data-private="${spec.root}"]`;
  const narrow: string[] = [];
  const wide: string[] = [];
  const order = [
    ...Object.keys(spec.styles).filter((target) => tokens[target]),
    ...Object.keys(tokens).filter((target) => target.startsWith("ui.")).sort(),
    ...Object.keys(tokens).filter((target) => target.startsWith("@")).sort(),
  ];
  for (const target of order) {
    const style = target.startsWith("@") ? null : styleOf(spec, target);
    const selector = style
      ? (style.absolute ? style.selector : style.selector ? `${root} ${style.selector}` : root)
      : `${root} [data-layout][data-hook="${target.slice(1)}"]`;
    const values = tokens[target] ?? {};
    const gap = typeof values.gap === "number" ? values.gap : 16;
    // One rule per target and place (its own element, the words inside), its tokens' declarations together.
    const rules = new Map<string, { wide: boolean; selectors: string; declarations: string[] }>();
    const declare = (wideOnly: boolean, selectors: string, declaration: string) => {
      const id = `${wideOnly ? "w" : "n"}${selectors}`;
      const rule = rules.get(id) ?? { wide: wideOnly, selectors, declarations: [] };
      rule.declarations.push(declaration);
      rules.set(id, rule);
    };
    for (const [name, value] of Object.entries(values)) {
      const token = PRIVATE_TOKEN_SPECS[name as PrivateTokenName];
      const columns = name === "columns" || name === "columns-wide";
      if (!token.write && !columns) continue;
      // An app's node has its own type: no word inside it draws its own size (each piece is a node of its own).
      // Token mode's specificity, as the colour table's: above the host's own rules (its filled buttons' radius).
      const selectors = (target.startsWith("ui.") && token.on?.[0] === "" ? [""] : token.on ?? [""]).map((suffix) => `${PRIVATE_TOKEN_MODE} :where(${selector})${suffix}`).join(",");
      const floor = unitHooks.has(target.slice(1)) ? UNIT_TRACK_FLOOR : PAGE_TRACK_FLOOR;
      if (columns) {
        // Measured on the box that holds the grid (a size container), never the viewport alone.
        const rule = `${selectors}{grid-template-columns:${tracks(value as Tracks, floor)};grid-auto-flow:row}`;
        const fit = Math.max(tracksFit(value as Tracks, gap, floor), name === "columns-wide" ? 640 : 0);
        narrow.push(`:where(${root} :has(> ${selector.slice(root.length + 1)})){container-type:inline-size}@container (min-width:${fit}px){${rule}}`);
      } else if (name === "size" && sizeFloor(spec, tokens, target) > 0) {
        // Never under what it outranks: a row the host keeps at 14px stays under a total its narrow box would shrink.
        declare(false, selectors, `font-size:max(${sizeFloor(spec, tokens, target)}px,min(${value as number}px,max(12px,${PAGE_FIT})))`);
      } else if (name === "padding") {
        // A box's padding leaves its children's focus rings (4px) and its own rounded corners (30% of the radius) on its surface.
        const room = Math.max(4, Math.ceil(0.3 * (typeof values.radius === "number" ? values.radius : 0)));
        declare(false, selectors, `padding:max(min(${value as number}px,4vw),${room}px)`);
      } else {
        declare(token.wide === true, selectors, token.write!(value as never));
      }
    }
    // A control or field the check may find by its edge draws that edge solid itself: no other rule's
    // `border-style` (a host class, another row) takes away the border the check read.
    const width = values["border-width"];
    const edge = style && "kind" in style ? (style as PrivateStyleSpec) : null;
    if (edge && (edge.boundary || edge.kind === "field") && typeof width === "number" && width > 0 && values["border-style"] === undefined) {
      declare(false, `${PRIVATE_TOKEN_MODE} :where(${selector})`, "border-style:solid");
    }
    for (const rule of rules.values()) (rule.wide ? wide : narrow).push(`${rule.selectors}{${rule.declarations.join(";")}}`);
  }
  const fit = narrow.some((rule) => rule.includes(PAGE_FIT)) ? `${PAGE_FIT_RULE}:where(${root}){--pt-fit:7cqi}` : "";
  return `${fit}${narrow.join("")}${wide.length > 0 ? `@media ${PRIVATE_WIDE_MEDIA}{${wide.join("")}}` : ""}`;
}

// ─── Token mode: the host's palette classes read the table ────────────────

/**
 * The page in token mode: `data-private-tokens` on `<html>`. Every token-mode
 * rule starts with it and holds the rest in `:where()`, so all have its
 * specificity (0,2,0): above the store's own rules (the body's colours, a
 * long answer's toggle), below a theme's region rules.
 */
export const PRIVATE_TOKEN_MODE = ":root[data-private-tokens]";

/**
 * Where token mode reaches: every private page with a page of its own (a page
 * is in token mode only where its own look was compiled: `data-private-tokens`
 * on its `<html>`), the store's dialogs over them and the store's own chrome
 * (its controls inside).
 */
const TOKEN_SCOPE = /* @__PURE__ */ (() => [
  ...Object.values(PRIVATE_PAGES as Readonly<Record<string, PrivatePageSpec>>).filter((spec) => Object.hasOwn(spec.styles, "page")).map((spec) => `[data-private="${spec.root}"]`),
  ...PRIVATE_SCOPES.map((scope) => `[data-private="${scope}"]`),
])();
/**
 * A payment provider's own surface (its card form, its frame: `data-part="gateway"`): token mode never reaches
 * into it, so it keeps the store's own colours whatever a theme sets (no row of the table names it either).
 */
export const PRIVATE_GATEWAY_HOOK = "gateway";
/**
 * The parts that keep the store's own look inside a page in token mode: a payment provider's surface, and the
 * receipt's recommendations (public product cards, drawn as on every public page). Token mode never reaches into
 * them, no row of the table names them, and they read the palette's own words and surfaces again.
 */
export const PRIVATE_OWN_LOOK_HOOKS = [PRIVATE_GATEWAY_HOOK, "recommendations"] as const;
const OWN_LOOK = /* @__PURE__ */ (() => PRIVATE_OWN_LOOK_HOOKS.flatMap((hook) => [`[data-part="${hook}"]`, `[data-part="${hook}"] *`]).join(","))();
const IN_SCOPE = /* @__PURE__ */ (() => `:is(${[...TOKEN_SCOPE, ...TOKEN_SCOPE.map((scope) => `${scope} *`)].join(",")}):not(${OWN_LOOK})`)();

/**
 * Every palette class the host draws on a private page, and what it reads in
 * token mode: a surface class paints nothing (the row beneath shows; a
 * target with a surface of its own is a row), a text, border or ring colour
 * reads the nearest row's cell (`--pt-t` text, `--pt-m` muted, `--pt-l` link,
 * `--pt-e` error, `--pt-b` border, `--pt-r` focus ring, `--pt-h` hover
 * surface, `--pt-p` placeholder, `--pt-i` error border). A variant applies in
 * its state (a hover only where the pointer can hover, as the store's own
 * classes). A class missing here fails the storefront's vocabulary test.
 */
export const PRIVATE_TOKEN_MODE_CLASSES: Readonly<Record<string, readonly [declaration: string, state?: string]>> = /* @__PURE__ */ (() => Object.fromEntries([
  ...["bg-background", "bg-card", "bg-muted", "bg-muted/40", "bg-muted/50", "bg-muted/60", "bg-primary", "bg-primary/10", "bg-primary/5", "bg-destructive", "bg-destructive/10",
    "bg-success/10", "bg-warning/10", "dark:bg-card",
  ].map((name) => [name, ["background-color:transparent"]] as const),
  // A hover surface is the nearest row's: visibly not its surface, its words readable on it.
  ...["hover:bg-background/70", "hover:bg-muted", "hover:bg-muted/40", "hover:bg-muted/50", "hover:bg-primary-hover", "sm:hover:bg-muted/60"].map((name) => [name, ["background-color:var(--pt-h)", ":hover"]] as const),
  ...["text-foreground", "text-card-foreground", "text-primary-foreground", "text-destructive-foreground"].map((name) => [name, ["color:var(--pt-t)"]] as const),
  ...["text-muted-foreground", "text-muted-foreground/60", "text-muted-foreground/40"].map((name) => [name, ["color:var(--pt-m)"]] as const),
  ...["text-primary", "text-primary-ink"].map((name) => [name, ["color:var(--pt-l)"]] as const),
  // A filled button's words are its row's own words (`text`), whatever its role; the error words are a row's `error`.
  ["text-destructive", ["color:var(--pt-e)"]],
  ["hover:text-foreground", ["color:var(--pt-t)", ":hover"]],
  ["hover:text-muted-foreground", ["color:var(--pt-m)", ":hover"]],
  ["hover:text-primary", ["color:var(--pt-l)", ":hover"]],
  ["disabled:text-muted-foreground", ["color:var(--pt-m)", ":disabled"]],
  ["placeholder:text-muted-foreground", ["color:var(--pt-p)", "::placeholder"]],
  ...["border-border", "border-input", "border-muted", "border-primary/20", "border-primary/30", "border-primary/40", "border-success/40", "border-warning/50", "border-destructive/30",
    "hover:border-foreground/30", "sm:border-border"].map((name) => [name, ["border-color:var(--pt-b)"]] as const),
  ["border-t-foreground", ["border-top-color:var(--pt-t)"]],
  ["border-primary", ["border-color:var(--pt-l)"]],
  ["border-destructive", ["border-color:var(--pt-e)"]],
  ...["divide-border", "divide-primary/15"].map((name) => [name, ["border-color:var(--pt-b)", ">*"]] as const),
  ["decoration-border", ["text-decoration-color:var(--pt-b)"]],
  ["ring-border", ["--tw-ring-color:var(--pt-b)"]],
  ["ring-destructive", ["--tw-ring-color:var(--pt-e)"]],
  ["accent-primary", ["accent-color:var(--pt-l)"]],
  ["focus-visible:outline-ring", ["outline-color:var(--pt-r)", ":focus-visible"]],
  ["has-[:focus-visible]:outline-ring", ["outline-color:var(--pt-r)", ":has(:focus-visible)"]],
  ...["focus-visible:ring-ring", "focus-visible:ring-ring/30"].map((name) => [name, ["--tw-ring-color:var(--pt-r)", ":focus-visible"]] as const),
  ...["focus:ring-ring", "focus:ring-ring/30"].map((name) => [name, ["--tw-ring-color:var(--pt-r)", ":focus"]] as const),
  ["focus-within:ring-ring/30", ["--tw-ring-color:var(--pt-r)", ":focus-within"]],
  ["has-[:focus-visible]:ring-ring/30", ["--tw-ring-color:var(--pt-r)", ":has(:focus-visible)"]],
  ["focus:border-ring", ["border-color:var(--pt-r)", ":focus"]],
  ["focus-within:border-ring", ["border-color:var(--pt-r)", ":focus-within"]],
  ["has-[:checked]:border-primary", ["border-color:var(--pt-l)", ":has(:checked)"]],
  ["has-[:checked]:ring-primary", ["--tw-ring-color:var(--pt-l)", ":has(:checked)"]],
  ["aria-[invalid=true]:border-destructive", ["border-color:var(--pt-i)", '[aria-invalid="true"]']],
  // The receipt and the account: their pills' and overlays' tints paint nothing (a thumbnail's count reads on the
  // row's hover surface), their borders are the row's, the account menu's current marker is its link colour.
  ...["bg-warning/15", "bg-success/15", "bg-muted/10", "bg-muted/20"].map((name) => [name, ["background-color:transparent"]] as const),
  // The conversation's file button (the reply form's attachment): the row's words, border and hover.
  ["file:bg-background", ["background-color:transparent", "::file-selector-button"]],
  ["file:text-foreground", ["color:var(--pt-t)", "::file-selector-button"]],
  ["file:border-border", ["border-color:var(--pt-b)", "::file-selector-button"]],
  ["hover:file:bg-muted", ["background-color:var(--pt-h)", "::file-selector-button"]],
  // A thumbnail's count stands on the card's row (its own tint would be a surface no row claims).
  ["bg-background/90", ["background-color:transparent"]],
  ["lg:hover:bg-muted", ["background-color:var(--pt-h)", ":hover"]],
  ...["border-muted-foreground/30", "hover:border-primary/40", "hover:border-foreground/25", "lg:border-border"].map((name) => [name, ["border-color:var(--pt-b)"]] as const),
  ["after:bg-primary", ["background-color:var(--pt-l)", "::after"]],
  ["ring-primary", ["--tw-ring-color:var(--pt-l)"]],
  ["focus-visible:after:ring-ring", ["--tw-ring-color:var(--pt-r)", ":focus-visible"]],
  ["focus:border-primary", ["border-color:var(--pt-r)", ":focus"]],
  ["focus:ring-primary/20", ["--tw-ring-color:var(--pt-r)", ":focus"]],
  // Every page of the account (its profile, inbox, warranties, reviews, gift cards and downloads): a tint paints
  // nothing, a hover is the row's, a rule line its border, a faint star its muted words, a ring its focus ring.
  ["bg-muted/30", ["background-color:transparent"]],
  ...["hover:bg-destructive/10", "hover:bg-destructive/90"].map((name) => [name, ["background-color:var(--pt-h)", ":hover"]] as const),
  ["bg-primary/30", ["background-color:var(--pt-b)"]],
  ["focus-visible:ring-primary", ["--tw-ring-color:var(--pt-r)", ":focus-visible"]],
  // The review form's star: its ring drawn while its radio has focus (a sibling's state): the colour is the row's ring always.
  ["[input:focus-visible+&]:ring-ring", ["--tw-ring-color:var(--pt-r)"]],
  ["focus:ring-primary/30", ["--tw-ring-color:var(--pt-r)", ":focus"]],
  // The store's outlined button (components/ui/button.tsx, the receipt's Print): its hover the row's, its ring offset clear.
  ["ring-offset-background", ["--tw-ring-offset-color:transparent"]],
  ["hover:bg-accent/50", ["background-color:var(--pt-h)", ":hover"]],
  ["hover:text-accent-foreground", ["color:var(--pt-t)", ":hover"]],
  ["hover:border-accent/50", ["border-color:var(--pt-b)", ":hover"]],
]))();

const classSelector = (name: string) => `.${name.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`)}`;

function classRules(names: readonly string[]): string {
  const groups = new Map<string, string[]>();
  for (const name of names) {
    const [declaration, state = ""] = PRIVATE_TOKEN_MODE_CLASSES[name]!;
    const key = `${state}\u0000${declaration}`;
    groups.set(key, [...groups.get(key) ?? [], classSelector(name)]);
  }
  return [...groups].map(([key, selectors]) => {
    const [state, declaration] = key.split("\u0000") as [string, string];
    const element = `${IN_SCOPE}:is(${selectors.join(",")})`;
    // A pseudo-element or a child stays outside the zero-specificity wrapper; a state stays inside it.
    const rule = `${PRIVATE_TOKEN_MODE} :where(${element}${state.startsWith(">") ? ` ${state}` : state.startsWith("::") ? "" : state})${state.startsWith("::") ? state : ""}{${declaration}}`;
    return state === ":hover" ? `@media (hover:hover){${rule}}` : rule;
  }).join("");
}

const SURFACE_CLASSES = /* @__PURE__ */ (() => Object.keys(PRIVATE_TOKEN_MODE_CLASSES).filter((name) => PRIVATE_TOKEN_MODE_CLASSES[name]![0] === "background-color:transparent"))();
/** The classes that paint a row's hover surface under the pointer. */
const HOVER_SURFACE_CLASSES = /* @__PURE__ */ (() => Object.keys(PRIVATE_TOKEN_MODE_CLASSES).filter((name) => PRIVATE_TOKEN_MODE_CLASSES[name]![0] === "background-color:var(--pt-h)" && PRIVATE_TOKEN_MODE_CLASSES[name]![1] === ":hover"))();

/**
 * The host's CSS around a page's table in token mode (`PRIVATE_TOKEN_MODE`):
 * `before` the rows, every palette surface paints nothing, every element's
 * words inherit (no store rule picks their colour) and every focus outline
 * is the row's ring; `after` them, every other palette class reads its row's
 * cell, as does every field's placeholder and error border. A row's own
 * element shows its own colours; its palette classes then name which of its
 * cells they read.
 */
/**
 * The words' colour of an app's node in token mode, by kind and tone: the
 * cell of the row it stands on its ink names (`critical` words the error
 * colour). An app's node row writes a colour only where the theme set one.
 */
const UI_WORDS_CSS = /* @__PURE__ */ (() => {
  const byCell = new Map<string, string[]>([["text", []]]);
  for (const style of Object.values(PRIVATE_BUYER_UI_STYLES)) {
    if (!style.style) continue;
    const add = (selector: string, role: PrivatePaletteRole) => byCell.set(cellOf(role), [...byCell.get(cellOf(role)) ?? [], selector]);
    add(style.kind, style.ink ?? "foreground");
    for (const tone of style.tones ?? []) if (style.toneInk?.[tone]) add(`${style.kind}[data-tone="${tone}"]`, style.toneInk[tone]!);
  }
  return [...byCell].filter(([, selectors]) => selectors.length > 0)
    .map(([cell, selectors]) => `${PRIVATE_TOKEN_MODE} :where([data-buyer-ui-target] :is(${selectors.join(",")})){color:var(${CELL_PROPERTY[cell as PrivateRowColour]})}`).join("");
})();

export const PRIVATE_TOKEN_MODE_CSS = {
  // Words inherit their row's colour (no store rule picks a palette colour for them, a long answer's toggle
  // included); the store's one focus ring (theme-foundation.css) reads `--focus-ring-color`: the row's ring.
  before: `${classRules(SURFACE_CLASSES)}${PRIVATE_TOKEN_MODE} :where(${IN_SCOPE}){color:inherit;--focus-ring-color:var(--pt-r)}`
    // A part on the store's own look stands on its own surface with the palette's words, never the row around it.
    + `${PRIVATE_TOKEN_MODE} :where(${PRIVATE_OWN_LOOK_HOOKS.map((hook) => `[data-part="${hook}"]`).join(",")}){color:var(--color-foreground);--focus-ring-color:var(--color-ring)}`
    // The recommendations paint the palette's page under them: the store's own cards on the store's own page.
    + `${PRIVATE_TOKEN_MODE} :where([data-part="recommendations"]){background-color:var(--color-background)}`
    + `${PRIVATE_TOKEN_MODE} :where(${IN_SCOPE}:focus-visible){outline-color:var(--pt-r)}${UI_WORDS_CSS}`
    // A rating's stars (rating-stars.css): the filled ones its row's colour, the empty ones its muted colour.
    + `${PRIVATE_TOKEN_MODE} :where(${IN_SCOPE}[data-part="rating"]){--sc-star-on:var(--pt-t);--sc-star-off:var(--pt-m)}`,
  after: `${classRules(Object.keys(PRIVATE_TOKEN_MODE_CLASSES).filter((name) => !SURFACE_CLASSES.includes(name)))}`
    // A hovered control whose row has no hover surface that keeps its words readable: underlined instead (`--pt-hd`).
    + `@media (hover:hover){${PRIVATE_TOKEN_MODE} :where(${IN_SCOPE}:is(${HOVER_SURFACE_CLASSES.map(classSelector).join(",")}):hover){text-decoration-line:var(--pt-hd,none)}}`
    // A mark the store fills with its action colour that is no button and no part of its own (an unread dot, a progress
    // bar's done steps): drawn in its row's link colour, which reads on the row (`action` is the store's buttons only).
    + `${PRIVATE_TOKEN_MODE} :where(${IN_SCOPE}.bg-primary:not(button,a,[role="button"],[data-part])){background-color:var(--pt-l)}`
    + `${PRIVATE_TOKEN_MODE} :where(${IN_SCOPE}:is(input,textarea))::placeholder{color:var(--pt-p)}`
    // A field's error border, a field box's too (`data-field`: its input inside says it is invalid).
    + `${PRIVATE_TOKEN_MODE} :where(${IN_SCOPE}:is(input,select,textarea)[aria-invalid="true"],${IN_SCOPE}[data-field]:has([aria-invalid="true"])){border-color:var(--pt-i)}`,
} as const;
