// A theme's look for the host parts of a private page: typed tokens, never
// selectors (docs: packages/plugin-sdk/docs/private-pages.md).
//
// Each page names its style targets (private-anatomy.ts `styles`) and the
// tokens each takes; a theme's layout node takes PRIVATE_LAYOUT_TOKENS by its
// hook (`@<hook>`), and an app's buyer UI nodes take tokens by kind
// (`ui.<kind>[.<tone>][@<app>][/<target>]`, PRIVATE_BUYER_UI_STYLES). A theme
// supplies values only, checked by type at save:
// - colours are a palette role (`card`, `primary`) or an opaque `#rrggbb`;
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
// where given, else a default that reads on the surface beneath. The host
// writes exactly those rows as CSS (`privateTableCss`), and the contrast check
// runs over exactly those rows (`privateTablePairs`): a pair the CSS draws is
// a pair the check reads. Inside the page, the host's palette classes read the
// nearest row (`PRIVATE_TOKEN_MODE_CSS`): a translucent tint or a palette
// colour never decides a colour there.
import { z } from "zod";
import { STOREFRONT_THEME_COLOR_KEYS, storefrontThemeContrast, type StorefrontThemeColors } from "./contrast";
import {
  PRIVATE_BUYER_UI_STYLES,
  PRIVATE_HOOK_PATTERN,
  PRIVATE_LAYOUT_TOKENS,
  PRIVATE_PAGES,
  type PrivateContentTone,
  type PrivateNode,
  type PrivatePageKey,
  type PrivatePageSpec,
  type PrivatePaletteRole,
  type PrivateStyleKind,
  type PrivateStyleSpec,
  type PrivateTokenName,
} from "./private-anatomy";

/** The contrast floors: text (WCAG 1.4.3 AA) and a field's marks and focus rings (WCAG 1.4.11). */
export const PRIVATE_CONTRAST_FLOOR = 4.5;
export const PRIVATE_MARK_CONTRAST_FLOOR = 3;

const HEX = /^#[0-9a-f]{6}$/;
const colorSchema = z.union([z.enum(STOREFRONT_THEME_COLOR_KEYS), z.string().regex(HEX, "An opaque colour, #rrggbb in lowercase, or a palette role.")]);
type ColorValue = z.infer<typeof colorSchema>;
const gradientSchema = z.object({
  shape: z.enum(["linear", "radial"]),
  angle: z.number().int().min(0).max(360).optional(),
  from: colorSchema,
  to: colorSchema,
}).strict();
type Gradient = z.infer<typeof gradientSchema>;
const trackSchema = z.union([z.enum(["auto", "min-content", "1fr", "2fr", "3fr", "4fr"]), z.number().int().min(24).max(480)]);
const tracksSchema = z.array(trackSchema).min(1).max(4);
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

/** The colour tokens: each is a cell of the table, never a rule of its own. */
export const PRIVATE_COLOUR_TOKENS = ["background", "gradient", "text", "muted", "link", "error", "placeholder", "ring", "invalid", "border"] as const satisfies readonly PrivateTokenName[];

export const PRIVATE_TOKEN_SPECS: Record<PrivateTokenName, TokenSpec> = {
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
  padding: { schema: px(0, 48), write: (value: number) => `padding:min(${value}px,4vw)` },
  gap: { schema: px(0, 48), write: (value: number) => `gap:min(${value}px,4vw)` },
  font: choice({ body: "font-family:var(--theme-font-body)", heading: "font-family:var(--theme-font-heading)" }),
  weight: choice({ 400: "font-weight:400", 500: "font-weight:500", 600: "font-weight:600", 700: "font-weight:700", 800: "font-weight:800" }),
  size: { schema: px(12, 40), write: (value: number) => `font-size:min(${value}px,max(12px,8vw))`, on: ["", " :where(.text-foreground,.text-card-foreground)"] },
  case: choice({ none: "text-transform:none", uppercase: "text-transform:uppercase" }),
  tracking: choice({ normal: "letter-spacing:normal", wide: "letter-spacing:0.04em", wider: "letter-spacing:0.08em" }),
  align: choice({ start: "text-align:start", center: "text-align:center", end: "text-align:end" }),
  // At least two lines: a title is never cut to one.
  clamp: choice({
    none: "display:block;-webkit-line-clamp:none;overflow:visible",
    2: "display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden",
    3: "display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden",
  }),
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
};

/** Where a phone ends (the store's `sm`). */
export const PRIVATE_WIDE_MEDIA = "(min-width:40rem)";

/** `privatePages.tokens`: per page, per style target (`@<layout hook>`, `ui.<kind>…`), per token, a value. */
// Names are checked by the compile (`unknown_style`, `unknown_token`) so the schema stays small.
export const privateTokensSchema = z.record(
  z.string().regex(/^[a-zA-Z]{1,24}$/),
  z.record(z.string().regex(/^(?:@[a-z][a-z0-9-]{0,40}|[a-z][a-z0-9-]{0,40}|ui\.[a-z]{1,12}(?:\.[a-z]{1,12})?(?:@[a-z0-9][a-z0-9.-]{0,63})?(?:\/[a-z_.]{1,64})?)$/), z.record(z.string().regex(/^[a-z][a-z-]{0,23}$/), z.unknown())),
).refine((tokens) => Object.keys(tokens).every((page) => Object.hasOwn(PRIVATE_PAGES, page)), "Tokens are set per private page: cart.") as unknown as z.ZodType<PrivateTokens>;
export type PrivateTokens = Partial<Record<PrivatePageKey, Record<string, Partial<Record<PrivateTokenName, unknown>>>>>;

export type PrivateTokenReason = "unknown_style" | "unknown_token" | "token_value" | "contrast" | "no_row";
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
}

/** A palette buyers can see, and the scheme it is drawn under (`<html data-color-scheme>`). */
export interface PrivatePalette {
  scheme: "light" | "dark";
  colors: StorefrontThemeColors;
}

/** What a page's tokens are checked against: its arrangement (layout hooks and where each part sits) and the palettes. */
export interface PrivateTokenContext {
  layout: readonly PrivateNode[];
  items: Readonly<Record<string, readonly PrivateNode[]>>;
  palettes: readonly PrivatePalette[];
}

const UI_KEY = /^ui\.([a-z]{1,12})(?:\.([a-z]{1,12}))?(?:@([a-z0-9][a-z0-9.-]{0,63}))?(?:\/([a-z_.]{1,64}))?$/;

/** The page's extension targets, its units' included. */
const pageTargets = (spec: PrivatePageSpec) => [...spec.targets, ...Object.values(spec.items).flatMap((item) => item.targets)];

/** A theme key's tokens and selector: an anatomy target, or an app node kind narrowed by tone, app and target. */
function styleOf(spec: PrivatePageSpec, key: string): { tokens: readonly PrivateTokenName[]; selector: string; absolute?: boolean } | null {
  if (Object.hasOwn(spec.styles, key)) return spec.styles[key]!;
  const match = UI_KEY.exec(key);
  if (!match) return null;
  const [, kind, tone, app, target] = match;
  const ui = Object.hasOwn(PRIVATE_BUYER_UI_STYLES, kind!) ? PRIVATE_BUYER_UI_STYLES[kind!]! : null;
  if (!ui || (tone && !ui.tones?.includes(tone as PrivateContentTone))) return null;
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
 * columns) as rules at zero specificity.
 */
export function compilePrivateTokens(page: PrivatePageKey, tokens: PrivateTokens[PrivatePageKey], context: PrivateTokenContext): { issues: PrivateTokenIssue[]; css: string; tables: PrivateTokenTable[] } {
  if (!tokens) return { issues: [], css: "", tables: [] };
  const { valid, issues } = validTokens(page, tokens, context);
  if (issues.length > 0) return { issues, css: "", tables: [] };
  const built = privateTokenTables(page, valid, context);
  if (built.issues.length > 0) return { issues: built.issues, css: "", tables: built.tables };
  const contrast = tableIssues(page, built.tables);
  if (contrast.length > 0) return { issues: contrast, css: "", tables: built.tables };
  const unitHooks = new Set<string>();
  for (const nodes of Object.values(context.items)) layoutHooks(nodes, unitHooks);
  for (const hook of layoutHooks(context.layout, new Set())) unitHooks.delete(hook);
  return { issues: [], css: `${privateTableCss(built.tables)}${shapeCss(page, valid, unitHooks)}`, tables: built.tables };
}

// ─── The colour table ─────────────────────────────────────────────────────

/** The colours of a row, each a cell the CSS writes and the check reads. */
export const PRIVATE_ROW_COLOURS = ["text", "muted", "link", "error", "border", "ring", "placeholder", "invalid"] as const;
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
  /** The colour of its own words: one of text, muted, link and error. */
  ink: string;
  text: string;
  muted: string;
  link: string;
  error: string;
  border: string;
  ring: string;
  /** A field's (and the page's, where every field reads it first) placeholder and error border. */
  placeholder: string | null;
  invalid: string | null;
  /** The theme key that set each cell, for a refusal's path. */
  from: Partial<Record<PrivateRowColour | "surface", string>>;
}

export interface PrivateTokenTable {
  palette: PrivatePalette;
  rows: PrivateTokenRow[];
}

/** A pair the check reads: a colour of a row over a surface it is drawn on, and the floor it must reach. */
export interface PrivateTokenPair {
  key: string;
  what: PrivateRowColour;
  fore: string;
  back: string;
  /** 4.5 for words, 3 for a field's marks and a focus ring, 1 for a box's border (it carries no meaning). */
  floor: number;
}

const ROLE_CELL: Partial<Record<PrivatePaletteRole, "text" | "muted" | "link" | "error">> = { "muted-foreground": "muted", primary: "link", destructive: "error" };
const cellOf = (role: PrivatePaletteRole) => ROLE_CELL[role] ?? "text";

/** The first colour that reads at `floor` on every one of `backs`: the candidates, black or white, then a grey; else the best there is. */
function readable(candidates: ReadonlyArray<string | null | undefined>, backs: readonly string[], floor: number): string {
  const worst = (colour: string) => Math.min(...backs.map((back) => storefrontThemeContrast(colour, back)));
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
  surface: PrivatePaletteRole | "under";
  ink: PrivatePaletteRole;
  /** The row beneath it, or `boxes`: every box of the page. */
  parent: string | "boxes" | null;
  /** Its element sits inside its parent's element, so it inherits the parent's cells (not a dialog, not the header's search). */
  nested: boolean;
  /** A row whose selector reaches every element this one does, always written before it (an app node kind's row with no tone). */
  base: string | null;
  /** The theme keys it reads, least specific first. */
  sources: string[];
}

/** Every row of the page as the arrangement places it, in the order the CSS writes them (an inner row after the rows it can share an element with). */
function placesOf(spec: PrivatePageSpec, tokens: Record<string, Values>, context: PrivateTokenContext): Place[] {
  const root = `[data-private="${spec.root}"]`;
  const places: Place[] = [];
  const styles = Object.entries(spec.styles);
  const selectorOf = (style: PrivateStyleSpec) => style.absolute ? style.selector : style.selector ? `${root} ${style.selector}` : root;
  const place = (key: string, style: PrivateStyleSpec, parent: Place["parent"]) => {
    places.push({ key, selector: selectorOf(style), kind: style.kind, surface: style.surface, ink: style.ink, parent, nested: parent !== "boxes" && parent !== null && !style.absolute, base: null, sources: [key] });
  };
  const inside = (key: string) => {
    for (const [name, style] of styles) {
      if (style.on !== key || style.absolute) continue;
      place(name, style, key);
      inside(name);
      if (spec.items[name]) walk(context.items[name] ?? spec.items[name]!.layout, name, name);
    }
  };
  const ui = (target: string, parent: string) => {
    const apps = new Map<string, Set<string>>();
    for (const key of Object.keys(tokens)) {
      const match = UI_KEY.exec(key);
      if (match?.[3] && (!match[4] || match[4] === target)) apps.set(match[1]!, (apps.get(match[1]!) ?? new Set()).add(match[3]));
    }
    // Every kind and tone first, then the apps the theme names (an app's rows win over the generic ones).
    for (const app of [undefined, ...new Set([...apps.values()].flatMap((set) => [...set]))]) {
      for (const [kind, style] of Object.entries(PRIVATE_BUYER_UI_STYLES)) {
        if (!style.style || (app && !apps.get(kind)?.has(app))) continue;
        for (const tone of [undefined, ...style.tones ?? []]) {
          const scope = (narrow: string) => [`ui.${kind}${narrow}`, `ui.${kind}${narrow}/${target}`];
          const sources = [...scope(""), ...(tone ? scope(`.${tone}`) : []), ...(app ? [...scope(`@${app}`), ...(tone ? scope(`.${tone}@${app}`) : [])] : [])];
          places.push({
            key: `ui.${kind}${tone ? `.${tone}` : ""}${app ? `@${app}` : ""}/${target}`,
            selector: `${root} ${uiSelector(style.kind, tone, app, target)}`,
            kind: style.style, surface: "under", ink: (tone && style.toneInk?.[tone]) || style.ink || "foreground", parent, nested: true,
            // A generic tone row adds nothing where it writes what its kind's row (always written) writes.
            base: tone && !app ? `ui.${kind}/${target}` : null, sources,
          });
        }
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
        for (const [name, style] of styles) {
          if (style.part !== node.part || style.item !== item) continue;
          place(name, style, parent);
          inside(name);
        }
      } else if (node.type === "target") {
        ui(node.target, parent);
      }
    }
  }
  // The page itself (`page`, the body) is the row everything else sits on.
  const pageKey = "page";
  place(pageKey, spec.styles[pageKey]!, null);
  // The page's frame, then the fields and buttons drawn anywhere, then the arrangement, then the dialogs and the header's search.
  for (const [name, style] of styles) if (style.on === pageKey && !style.absolute) place(name, style, pageKey);
  for (const [name, style] of styles) if (!style.on && !style.part && !style.item && !style.layout && name !== pageKey) place(name, style, "boxes");
  const frame = places[1]?.key ?? pageKey;
  walk(context.layout, frame, undefined);
  for (const [name, style] of styles) {
    if (!style.absolute || style.on !== pageKey) continue;
    place(name, style, pageKey);
    for (const [child, inner] of styles) if (inner.on === name) place(child, inner, name);
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

/** One palette's rows, each resolved from the theme's tokens and the surface beneath. */
function resolveRows(places: readonly Place[], tokens: Record<string, Values>, palette: PrivatePalette): PrivateTokenRow[] {
  const colors = palette.colors;
  const hex = (value: unknown) => HEX.test(String(value)) ? String(value) : colors[value as keyof StorefrontThemeColors];
  const byKey = new Map<string, PrivateTokenRow>();
  const boxes = () => [...byKey.values()].filter((row) => row.kind === "box");
  const resolve = (place: Place): PrivateTokenRow => {
    const { values, from: set } = merged(tokens, place.sources);
    const parents = place.parent === "boxes" ? boxes() : place.parent ? [byKey.get(place.parent)!] : [];
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
    } else if (place.surface === "under") {
      surface = parent?.surface ?? [colors.background];
      paint = surface.length === 1 ? surface[0]! : null;
      from.surface = parent?.from.surface;
    } else {
      paint = colors[place.surface];
      surface = [paint];
    }
    // A row with no surface of its own reads first what the row beneath reads on that same surface.
    const under = place.surface === "under" && !fill && !values.background ? parent : null;
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
    const text = take("text", own("text"), [under?.text, colors[cell === "text" ? place.ink : "foreground"], colors.foreground, colors.background], surface, PRIVATE_CONTRAST_FLOOR);
    const muted = take("muted", own("muted"), [under?.muted, colors["muted-foreground"], text], surface, PRIVATE_CONTRAST_FLOOR);
    const link = take("link", own("link"), [under?.link, colors.primary, text], surface, PRIVATE_CONTRAST_FLOOR);
    const error = take("error", own("error"), [under?.error, colors.destructive, text], surface, PRIVATE_CONTRAST_FLOOR);
    // What a field's marks and a control's focus ring are drawn on: the rows beneath (a page's own surface).
    const around = parents.length > 0 ? parents.flatMap((row) => row.surface) : surface;
    const marked = place.kind === "field" || place.kind === "control";
    // A control's or a field's own ring is drawn outside it; a box's rings are its children's, drawn on it.
    const ring = take("ring", "ring", [under?.ring, colors.ring, text, colors.foreground, colors.background], marked ? around : surface, PRIVATE_MARK_CONTRAST_FLOOR);
    const border = place.kind === "field"
      ? take("border", "border", [colors.input, colors.border, muted, text], around, PRIVATE_MARK_CONTRAST_FLOOR)
      : take("border", "border", [under?.border ?? colors.border], surface, 1);
    const field = place.kind === "field" || place.parent === null;
    const placeholder = field ? take("placeholder", "placeholder", [colors["muted-foreground"], muted, text], surface, PRIVATE_CONTRAST_FLOOR) : null;
    const invalid = field ? take("invalid", "invalid", [colors.destructive, error, text], around, PRIVATE_MARK_CONTRAST_FLOOR) : null;
    const cells = { text, muted, link, error };
    const row: PrivateTokenRow = {
      key: place.key, sources: place.sources, selector: place.selector, kind: place.kind, parents: parents.map((each) => each.key), nested: place.nested, base: place.base,
      paint, gradient, surface, ink: cells[cell], text, muted, link, error, border, ring, placeholder, invalid, from,
    };
    return row;
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
export function privateTokenTables(page: PrivatePageKey, tokens: Record<string, Values>, context: PrivateTokenContext, spec: PrivatePageSpec = PRIVATE_PAGES[page]): { tables: PrivateTokenTable[]; issues: PrivateTokenIssue[] } {
  const places = placesOf(spec, tokens, context);
  const issues: PrivateTokenIssue[] = [];
  const keys = new Set(places.map((place) => place.key));
  const layouts = new Set<string>();
  const collect = (nodes: readonly PrivateNode[]) => { for (const node of nodes) if (node.type === "layout") { layouts.add(node.layout); collect(node.children); } };
  collect(context.layout);
  for (const [name, style] of Object.entries(spec.styles)) {
    // A target only a host layout draws (the fold's bar) has no row where the arrangement has no such layout.
    if (keys.has(name) || (style.layout && !layouts.has(style.layout))) continue;
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
    const add = (what: PrivateRowColour, fore: string | null, backs: readonly string[], floor: number) => {
      if (fore) for (const back of new Set(backs)) pairs.push({ key: row.key, what, fore, back, floor });
    };
    for (const what of ["text", "muted", "link", "error", "placeholder"] as const) add(what, row[what], row.surface, PRIVATE_CONTRAST_FLOOR);
    add("ring", row.ring, marked ? around : row.surface, PRIVATE_MARK_CONTRAST_FLOOR);
    add("border", row.border, row.kind === "field" ? around : row.surface, row.kind === "field" ? PRIVATE_MARK_CONTRAST_FLOOR : 1);
    add("invalid", row.invalid, around, PRIVATE_MARK_CONTRAST_FLOOR);
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
      const target = row.from[pair.what] ?? row.from.surface ?? row.parents.map((key) => byKey.get(key)?.from.surface).find(Boolean) ?? row.sources.at(-1) ?? row.key;
      const id = `${target}|${pair.key}|${pair.what}|${pair.fore}|${pair.back}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const where = pair.key === target ? target : `${target} (${pair.key})`;
      issues.push({ path: ["privatePages", "tokens", page, target], reason: "contrast", message: `${where}: ${pair.what} ${pair.fore} on ${pair.back} is ${ratio.toFixed(2)}:1, under the ${pair.floor}:1 a buyer needs.` });
    }
  }
  return issues;
}

const CELL_PROPERTIES = [["text", "--pt-t"], ["muted", "--pt-m"], ["link", "--pt-l"], ["error", "--pt-e"], ["border", "--pt-b"], ["ring", "--pt-r"], ["placeholder", "--pt-p"], ["invalid", "--pt-i"]] as const;

/**
 * A row's cells as declarations: its paint, its own words' colour and the
 * cells everything inside it reads (`--pt-*`). A nested row's element
 * inherits its parent's cells and shows its parent's paint, so only what
 * differs is written (its own words' colour always).
 */
export function privateRowDeclarations(row: PrivateTokenRow, parent: PrivateTokenRow | null): string {
  const inherited = row.nested ? parent : null;
  const paints = row.paint !== null && !(inherited && inherited.surface.length === 1 && inherited.paint === row.paint && !row.gradient);
  return [
    paints ? `background-color:${row.paint}` : "",
    row.gradient ? `background-image:${row.gradient}` : "",
    `color:${row.ink}`,
    row.kind === "field" ? `border-color:${row.border}` : "",
    ...CELL_PROPERTIES.map(([cell, property]) => row[cell] && row[cell] !== inherited?.[cell] ? `${property}:${row[cell]}` : ""),
  ].filter(Boolean).join(";");
}

/**
 * The table as CSS, row by row in its order (neighbours with the same cells
 * share one rule, and a row whose base row writes the same is not written
 * again): the first palette as it is, a second (dark) under the page's dark
 * scheme. Every token-mode rule has the specificity of `PRIVATE_TOKEN_MODE`
 * alone, above the store's own rules for these elements and below the
 * theme's region rules, so a later row wins where two reach one element and
 * the host's palette classes after them read the row's cells.
 */
export function privateTableCss(tables: readonly PrivateTokenTable[]): string {
  return tables.map((table, index) => {
    const scope = index === 0 ? PRIVATE_TOKEN_MODE : `${PRIVATE_TOKEN_MODE}:where([data-color-scheme="dark"])`;
    const byKey = new Map(table.rows.map((row) => [row.key, row]));
    const written = new Map<string, string>();
    const rules: Array<{ selectors: string[]; declarations: string }> = [];
    for (const row of table.rows) {
      const declarations = privateRowDeclarations(row, row.parents.length === 1 ? byKey.get(row.parents[0]!)! : null);
      written.set(row.key, declarations);
      if (row.base && written.get(row.base) === declarations) continue;
      const last = rules.at(-1);
      if (last?.declarations === declarations) last.selectors.push(row.selector);
      else rules.push({ selectors: [row.selector], declarations });
    }
    const css = rules.map((rule) => `${scope} :where(${rule.selectors.join(",")}){${rule.declarations}}`).join("");
    return index === 0 ? css : `@media screen{${css}}`;
  }).join("");
}

/** The palettes a theme's buyers can see, each with the scheme it is drawn under. */
export function privatePalettes(theme: PrivatePalettesInput, dark: (colors: StorefrontThemeColors) => StorefrontThemeColors): PrivatePalette[] {
  const light = theme.colorScheme !== "dark" || theme.colorSchemeToggle;
  const showsDark = theme.colorScheme !== "light" || theme.colorSchemeToggle;
  return [
    ...(light ? [{ scheme: "light" as const, colors: theme.colors }] : []),
    ...(showsDark ? [{ scheme: "dark" as const, colors: theme.darkColors ?? dark(theme.colors) }] : []),
  ];
}

// ─── The rest of the look ─────────────────────────────────────────────────

/** The narrowest box a grid's tracks fit, each at least its floor, with the gaps: below it, the host's one column. */
function tracksFit(value: Tracks, gap: number, floor: number): number {
  return value.reduce<number>((sum, track) => sum + Math.max(floor, typeof track === "number" ? track : floor), 0) + gap * (value.length - 1);
}

/**
 * Each target's tokens that are not colours (sizes, spacing, type, columns)
 * as rules at zero specificity under the page root (or as the anatomy places
 * it), in the anatomy's order, its wide values in the wide media query and a
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
    for (const [name, value] of Object.entries(values)) {
      const token = PRIVATE_TOKEN_SPECS[name as PrivateTokenName];
      const columns = name === "columns" || name === "columns-wide";
      if (!token.write && !columns) continue;
      const selectors = (token.on ?? [""]).map((suffix) => `:where(${selector})${suffix}`).join(",");
      const floor = unitHooks.has(target.slice(1)) ? UNIT_TRACK_FLOOR : PAGE_TRACK_FLOOR;
      if (columns) {
        // Measured on the box that holds the grid (a size container), never the viewport alone.
        const rule = `${selectors}{grid-template-columns:${tracks(value as Tracks, floor)};grid-auto-flow:row}`;
        const fit = Math.max(tracksFit(value as Tracks, gap, floor), name === "columns-wide" ? 640 : 0);
        narrow.push(`:where(${root} :has(> ${selector.slice(root.length + 1)})){container-type:inline-size}@container (min-width:${fit}px){${rule}}`);
      } else {
        (token.wide ? wide : narrow).push(`${selectors}{${token.write!(value as never)}}`);
      }
    }
  }
  return `${narrow.join("")}${wide.length > 0 ? `@media ${PRIVATE_WIDE_MEDIA}{${wide.join("")}}` : ""}`;
}

// ─── Token mode: the host's palette classes read the table ────────────────

/**
 * The page in token mode: `data-private-tokens` on `<html>`. Every token-mode
 * rule starts with it and holds the rest in `:where()`, so all have its
 * specificity (0,2,0): above the store's own rules (the body's colours, a
 * long answer's toggle), below a theme's region rules.
 */
export const PRIVATE_TOKEN_MODE = ":root[data-private-tokens]";

/** Where token mode reaches: the private pages, the store's dialogs over them and the host's search. */
const TOKEN_SCOPE = ['[data-private="cart"]', '[data-private="dialog"]', '[data-host="search"]'];
const IN_SCOPE = `:is(${[...TOKEN_SCOPE, ...TOKEN_SCOPE.map((scope) => `${scope} *`)].join(",")})`;

/**
 * Every palette class the host draws on a private page, and what it reads in
 * token mode: a surface class paints nothing (the row beneath shows; a
 * target with a surface of its own is a row), a text, border or ring colour
 * reads the nearest row's cell (`--pt-t` text, `--pt-m` muted, `--pt-l` link,
 * `--pt-e` error, `--pt-b` border, `--pt-r` focus ring, `--pt-p` placeholder,
 * `--pt-i` error border). A variant applies in its state; a hover surface
 * never paints. A class missing here fails the storefront's vocabulary test.
 */
export const PRIVATE_TOKEN_MODE_CLASSES: Readonly<Record<string, readonly [declaration: string, state?: string]>> = Object.fromEntries([
  ...["bg-background", "bg-card", "bg-muted", "bg-muted/40", "bg-muted/50", "bg-muted/60", "bg-primary", "bg-primary/10", "bg-primary/5", "bg-destructive", "bg-destructive/10",
    "bg-success/10", "bg-warning/10", "dark:bg-card", "hover:bg-background/70", "hover:bg-muted", "hover:bg-muted/40", "hover:bg-muted/50", "hover:bg-primary/90", "sm:hover:bg-muted/60",
  ].map((name) => [name, ["background-color:transparent"]] as const),
  ...["text-foreground", "text-card-foreground", "text-primary-foreground"].map((name) => [name, ["color:var(--pt-t)"]] as const),
  ...["text-muted-foreground", "text-muted-foreground/60"].map((name) => [name, ["color:var(--pt-m)"]] as const),
  ...["text-primary", "text-primary-ink"].map((name) => [name, ["color:var(--pt-l)"]] as const),
  ...["text-destructive", "text-destructive-foreground"].map((name) => [name, ["color:var(--pt-e)"]] as const),
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
]);

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
    return `${PRIVATE_TOKEN_MODE} :where(${element}${state.startsWith(">") ? ` ${state}` : state.startsWith("::") ? "" : state})${state.startsWith("::") ? state : ""}{${declaration}}`;
  }).join("");
}

const SURFACE_CLASSES = Object.keys(PRIVATE_TOKEN_MODE_CLASSES).filter((name) => PRIVATE_TOKEN_MODE_CLASSES[name]![0] === "background-color:transparent");

/**
 * The host's CSS around a page's table in token mode (`PRIVATE_TOKEN_MODE`):
 * `before` the rows, every palette surface paints nothing, every element's
 * words inherit (no store rule picks their colour) and every focus outline
 * is the row's ring; `after` them, every other palette class reads its row's
 * cell, as does every field's placeholder and error border. A row's own
 * element shows its own colours; its palette classes then name which of its
 * cells they read.
 */
export const PRIVATE_TOKEN_MODE_CSS = {
  // Words inherit their row's colour (no store rule picks a palette colour for them, a long answer's toggle
  // included); the store's one focus ring (theme-foundation.css) reads `--focus-ring-color`: the row's ring.
  before: `${classRules(SURFACE_CLASSES)}${PRIVATE_TOKEN_MODE} :where(${IN_SCOPE}){color:inherit;--focus-ring-color:var(--pt-r)}${PRIVATE_TOKEN_MODE} :where(${IN_SCOPE}:focus-visible){outline-color:var(--pt-r)}`,
  after: `${classRules(Object.keys(PRIVATE_TOKEN_MODE_CLASSES).filter((name) => !SURFACE_CLASSES.includes(name)))}`
    + `${PRIVATE_TOKEN_MODE} :where(${IN_SCOPE}:is(input,textarea))::placeholder{color:var(--pt-p)}`
    + `${PRIVATE_TOKEN_MODE} :where(${IN_SCOPE}:is(input,select,textarea)[aria-invalid="true"]){border-color:var(--pt-i)}`,
} as const;
