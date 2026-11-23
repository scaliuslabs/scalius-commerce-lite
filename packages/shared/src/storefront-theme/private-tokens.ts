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
// The host writes every rule from them, all at zero specificity (`:where`),
// so the anatomy's order (outer targets first) decides, never selector
// weight. A text colour reaches only text drawn on the target's own
// surface: it travels as a custom property that every host element with a
// surface of its own (a field, a button or chip with a background, a nested
// card) resets, so it never recolours a field's words. The save keeps every
// text the host draws at 4.5:1 and every field's border, focus ring and
// error border at 3:1 against what is beneath it, in every palette buyers
// can see, gradients at their worst point (`contrast`).
import { z } from "zod";
import { STOREFRONT_THEME_COLOR_KEYS, storefrontThemeContrast, type StorefrontThemeColors } from "./contrast";
import {
  PRIVATE_BUYER_UI_STYLES,
  PRIVATE_HOOK_PATTERN,
  PRIVATE_LAYOUT_TOKENS,
  PRIVATE_PAGES,
  type PrivateNode,
  type PrivatePageKey,
  type PrivatePageSpec,
  type PrivatePaletteRole,
  type PrivateStyleSpec,
  type PrivateTokenName,
} from "./private-anatomy";

/** The contrast floors: text (WCAG 1.4.3 AA) and a field's marks (WCAG 1.4.11). */
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
  /** Its declarations, from a valid value. */
  write(value: never): string;
  /** Where it applies besides the target itself (selector suffixes; "" is the target). */
  on?: readonly string[];
  /** Above the phone width only. */
  wide?: boolean;
};

const px = (min: number, max: number) => z.number().int().min(min).max(max);
const color = (value: ColorValue) => HEX.test(value) ? value : `var(--${value})`;
const gradient = (value: Gradient) => value.shape === "linear"
  ? `linear-gradient(${value.angle ?? 180}deg,${color(value.from)},${color(value.to)})`
  : `radial-gradient(circle at top,${color(value.from)},${color(value.to)})`;
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
/** A text colour: set on the target, carried to its own text by a custom property the host's surfaces reset. */
const ink = (property: string) => (value: ColorValue) => `${property}:${color(value)};color:${color(value)}`;

export const PRIVATE_TOKEN_SPECS: Record<PrivateTokenName, TokenSpec> = {
  background: { schema: colorSchema, write: (value: ColorValue) => `background-color:${color(value)}` },
  gradient: { schema: gradientSchema, write: (value: Gradient) => `background-image:${gradient(value)}` },
  text: { schema: colorSchema, write: ink("--pt-fg") },
  muted: { schema: colorSchema, write: (value: ColorValue) => `--pt-muted:${color(value)}` },
  link: { schema: colorSchema, write: (value: ColorValue) => `--pt-link:${color(value)}` },
  error: { schema: colorSchema, write: (value: ColorValue) => `--pt-error:${color(value)}` },
  placeholder: { schema: colorSchema, write: (value: ColorValue) => `color:${color(value)}`, on: ["::placeholder"] },
  // A field's focus ring and error border (its marks).
  ring: { schema: colorSchema, write: (value: ColorValue) => `outline-color:${color(value)};--tw-ring-color:${color(value)}`, on: [":focus", ":focus-visible", ":focus-within"] },
  invalid: { schema: colorSchema, write: (value: ColorValue) => `border-color:${color(value)}`, on: ['[aria-invalid="true"]'] },
  border: { schema: colorSchema, write: (value: ColorValue) => `border-color:${color(value)}`, on: ["", " :where(.border-border,.divide-border>*)"] },
  "border-width": { schema: px(0, 4), write: (value: number) => `border-width:${value}px` },
  "border-style": choice({ solid: "border-style:solid", dashed: "border-style:dashed", dotted: "border-style:dotted", none: "border-style:none" }),
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
  columns: { schema: tracksSchema, write: (value: Tracks) => `grid-template-columns:${tracks(value, PAGE_TRACK_FLOOR)};grid-auto-flow:row` },
  "columns-wide": { schema: tracksSchema, write: (value: Tracks) => `grid-template-columns:${tracks(value, PAGE_TRACK_FLOOR)};grid-auto-flow:row`, wide: true },
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

/**
 * The host's rule under every token rule: a host element with a surface of
 * its own (a field, anything drawn with a background) resets the text
 * colours a target carries, so they reach only text on the target's surface.
 */
export const PRIVATE_TOKEN_BASE_CSS =
  ':where([data-private]) :where(input,select,textarea,[class^="bg-"],[class*=" bg-"]){--pt-fg:initial;--pt-muted:initial;--pt-link:initial;--pt-error:initial}';

/** The host classes each carried colour reads, and their own palette colour when it is reset. */
const CARRIED: Partial<Record<PrivateTokenName, Array<[string, string, string]>>> = {
  text: [[".text-foreground", "--pt-fg", "--color-foreground"], [".text-card-foreground", "--pt-fg", "--color-card-foreground"]],
  muted: [[".text-muted-foreground", "--pt-muted", "--color-muted-foreground"]],
  link: [[".text-primary", "--pt-link", "--color-primary"]],
  error: [[".text-destructive", "--pt-error", "--color-destructive"]],
};

/** `privatePages.tokens`: per page, per style target (`@<layout hook>`, `ui.<kind>…`), per token, a value. */
// Names are checked by the compile (`unknown_style`, `unknown_token`) so the schema stays small.
export const privateTokensSchema = z.record(
  z.string().regex(/^[a-zA-Z]{1,24}$/),
  z.record(z.string().regex(/^(?:@[a-z][a-z0-9-]{0,40}|[a-z][a-z0-9-]{0,40}|ui\.[a-z]{1,12}(?:\.[a-z]{1,12})?(?:@[a-z0-9][a-z0-9.-]{0,63})?(?:\/[a-z_.]{1,64})?)$/), z.record(z.string().regex(/^[a-z][a-z-]{0,23}$/), z.unknown())),
).refine((tokens) => Object.keys(tokens).every((page) => Object.hasOwn(PRIVATE_PAGES, page)), "Tokens are set per private page: cart.") as unknown as z.ZodType<PrivateTokens>;
export type PrivateTokens = Partial<Record<PrivatePageKey, Record<string, Partial<Record<PrivateTokenName, unknown>>>>>;

export type PrivateTokenReason = "unknown_style" | "unknown_token" | "token_value" | "contrast";
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

/** What a page's tokens are checked against: its arrangement (layout hooks and where each part sits) and the palettes. */
export interface PrivateTokenContext {
  layout: readonly PrivateNode[];
  items: Readonly<Record<string, readonly PrivateNode[]>>;
  palettes: readonly StorefrontThemeColors[];
}

const UI_KEY = /^ui\.([a-z]{1,12})(?:\.([a-z]{1,12}))?(?:@([a-z0-9][a-z0-9.-]{0,63}))?(?:\/([a-z_.]{1,64}))?$/;

/** A page's style target by its key: an anatomy target, or an app node kind narrowed by tone, app and target. */
function styleOf(spec: PrivatePageSpec, key: string): PrivateStyleSpec | null {
  if (Object.hasOwn(spec.styles, key)) return spec.styles[key]!;
  const match = UI_KEY.exec(key);
  if (!match) return null;
  const [, kind, tone, app, target] = match;
  const ui = Object.hasOwn(PRIVATE_BUYER_UI_STYLES, kind!) ? PRIVATE_BUYER_UI_STYLES[kind!]! : null;
  if (!ui || (tone && !ui.tones?.includes(tone))) return null;
  const targets = [...spec.targets, ...Object.values(spec.items).flatMap((item) => item.targets)];
  if (target && !targets.includes(target)) return null;
  const selector = [
    target ? `[data-buyer-ui-target="${target}"]` : "[data-buyer-ui-target]",
    app ? `[data-buyer-ui-app="${app}"]` : "[data-buyer-ui-app]",
    `${ui.kind}${tone ? `[data-tone="${tone}"]` : ""}`,
  ].join(" ");
  return { ...ui, selector };
}

function layoutHooks(nodes: readonly PrivateNode[], out: Set<string>): Set<string> {
  for (const node of nodes) {
    if (node.type !== "layout") continue;
    if (node.hook) out.add(node.hook);
    layoutHooks(node.children, out);
  }
  return out;
}

/** The hooks of the layout nodes holding `part`, innermost first. */
function ancestors(nodes: readonly PrivateNode[], part: string, trail: string[] = []): string[] | null {
  for (const node of nodes) {
    if (node.type === "part" && node.part === part) return [...trail].reverse();
    if (node.type === "layout") {
      const found = ancestors(node.children, part, node.hook ? [...trail, node.hook] : trail);
      if (found) return found;
    }
  }
  return null;
}

/** A colour as it reads in one palette. */
const hex = (value: ColorValue, palette: StorefrontThemeColors) => HEX.test(value) ? value : palette[value as keyof StorefrontThemeColors];

/** Points along a gradient as the browser paints it (sRGB interpolation): the ends and 31 between. */
function gradientPoints(from: string, to: string): string[] {
  const channels = (value: string) => [1, 3, 5].map((at) => Number.parseInt(value.slice(at, at + 2), 16));
  const [a, b] = [channels(from), channels(to)];
  return Array.from({ length: 33 }, (_, step) => `#${a.map((channel, index) => Math.round(channel + ((b[index]! - channel) * step) / 32).toString(16).padStart(2, "0")).join("")}`);
}

interface Resolved { colors: string[]; touched: boolean }

/** Each page's tokens checked: names, values by type, and every text and field mark the host draws against what is beneath it. */
export function privateTokenIssues(page: PrivatePageKey, tokens: PrivateTokens[PrivatePageKey], context: PrivateTokenContext): PrivateTokenIssue[] {
  if (!tokens) return [];
  const spec: PrivatePageSpec = PRIVATE_PAGES[page];
  const issues: PrivateTokenIssue[] = [];
  const hooks = layoutHooks(context.layout, new Set());
  for (const nodes of Object.values(context.items)) layoutHooks(nodes, hooks);
  const valid: Record<string, Partial<Record<PrivateTokenName, unknown>>> = {};
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
  if (issues.length > 0) return issues;
  return contrastIssues(page, spec, valid, context);
}

/** The text token that recolours a role drawn on a target's surface. */
const ROLE_TOKEN: Record<string, PrivateTokenName> = { foreground: "text", "card-foreground": "text", "muted-foreground": "muted", primary: "link", destructive: "error" };

function contrastIssues(page: PrivatePageKey, spec: PrivatePageSpec, tokens: Record<string, Partial<Record<PrivateTokenName, unknown>>>, context: PrivateTokenContext): PrivateTokenIssue[] {
  const issues: PrivateTokenIssue[] = [];
  const seen = new Set<string>();
  const unitRoot = Object.entries(spec.styles).find(([, style]) => style.selector === '[data-part="line"]')?.[0];
  const style = (target: string) => styleOf(spec, target)!;
  for (const palette of context.palettes) {
    const own = (target: string): Resolved | null => {
      const values = tokens[target];
      const fill = values?.gradient as Gradient | undefined;
      if (fill) return { colors: gradientPoints(hex(fill.from, palette), hex(fill.to, palette)), touched: true };
      if (values?.background) return { colors: [hex(values.background as ColorValue, palette)], touched: true };
      return null;
    };
    const pageBackground = (): Resolved => own("page") ?? { colors: [palette.background], touched: false };
    const beneath = (target: PrivateStyleSpec): Resolved => {
      if (target.on) return background(target.on);
      if (target.part) {
        const trail = ancestors(target.item ? context.items[target.item] ?? [] : context.layout, target.part) ?? [];
        for (const hook of trail) {
          const found = own(`@${hook}`);
          if (found) return found;
        }
        if (target.item && unitRoot) return background(unitRoot);
      }
      return pageBackground();
    };
    const background = (target: string): Resolved => {
      const found = style(target);
      return own(target) ?? (found.surface !== "under" ? { colors: [palette[found.surface]], touched: false } : beneath(found));
    };
    /** A text role as it reads inside `target`: its own token, else (on a target with no surface of its own) what the target beneath sets. */
    const text = (target: string, role: string, first: boolean): Resolved => {
      const found = style(target);
      const values = tokens[target];
      // Its own colour (first) is the text token; each role inside reads its own token (a field's muted text is its placeholder).
      const token = role === "muted-foreground" && found.marks ? "placeholder" : ROLE_TOKEN[role];
      const set = (first ? values?.text : undefined) ?? (token ? values?.[token] : undefined);
      if (set) return { colors: [hex(set as ColorValue, palette)], touched: true };
      const parent = found.surface === "under" ? found.on ?? (found.item ? unitRoot : undefined) : undefined;
      if (parent && parent !== target && ROLE_TOKEN[role]) return text(parent, role, false);
      return { colors: [palette[role as keyof StorefrontThemeColors]], touched: false };
    };
    const check = (label: string, path: Array<string | number>, inks: Resolved[], under: Resolved, floor: number, what: string) => {
      for (const ink of inks) {
        if (!ink.touched && !under.touched) continue;
        for (const fore of ink.colors) for (const back of under.colors) {
          const ratio = storefrontThemeContrast(fore, back);
          const key = `${label}|${what}|${fore}|${back}`;
          if (ratio >= floor || seen.has(key)) continue;
          seen.add(key);
          issues.push({ path, reason: "contrast", message: `${label}: ${what} ${fore} on ${back} is ${ratio.toFixed(2)}:1, under the ${floor}:1 a buyer needs.` });
        }
      }
    };
    const targets = [...Object.keys(spec.styles), ...Object.keys(tokens).filter((key) => key.startsWith("ui."))];
    for (const target of targets) {
      const found = style(target);
      const path = ["privatePages", "tokens", page, target];
      const inks = found.text.map((role, index) => text(target, role, index === 0));
      // Drawn in several places: checked on each (its own surface, when it has one, is beneath its words).
      const unders = found.within && found.surface === "under" && !own(target) ? found.within.map((place) => background(place)) : [background(target)];
      for (const under of unders) check(target, path, inks, under, PRIVATE_CONTRAST_FLOOR, "text");
      // A field's border, focus ring and error border read on what is around it.
      if (found.marks) {
        const values = tokens[target];
        const markToken: Partial<Record<PrivatePaletteRole, PrivateTokenName>> = { input: "border", ring: "ring", destructive: "invalid" };
        const marks = found.marks.map((role): Resolved => {
          const set = markToken[role] ? values?.[markToken[role]!] : undefined;
          return set ? { colors: [hex(set as ColorValue, palette)], touched: true } : { colors: [palette[role]], touched: false };
        });
        const around = (found.within ?? (found.on ? [found.on] : ["page"])).map((place) => background(place));
        for (const under of around) check(target, path, marks, under, PRIVATE_MARK_CONTRAST_FLOOR, "mark");
      }
    }
    // A layout node's background is beneath whatever it holds that has no colour of its own.
    for (const target of Object.keys(tokens).filter((key) => key.startsWith("@"))) {
      const under = own(target);
      if (under) check(target, ["privatePages", "tokens", page, target], [{ colors: [palette.foreground, palette["muted-foreground"]], touched: false }], under, PRIVATE_CONTRAST_FLOOR, "text");
    }
  }
  return issues;
}

/** The palettes a theme's buyers can see. */
export function privatePalettes(theme: PrivatePalettesInput, dark: (colors: StorefrontThemeColors) => StorefrontThemeColors): StorefrontThemeColors[] {
  const light = theme.colorScheme !== "dark" || theme.colorSchemeToggle;
  const showsDark = theme.colorScheme !== "light" || theme.colorSchemeToggle;
  return [...(light ? [theme.colors] : []), ...(showsDark ? [theme.darkColors ?? dark(theme.colors)] : [])];
}

/** The narrowest box a grid's tracks fit, each at least its floor, with the gaps: below it, the host's one column. */
function tracksFit(value: Tracks, gap: number, floor: number): number {
  return value.reduce<number>((sum, track) => sum + Math.max(floor, typeof track === "number" ? track : floor), 0) + gap * (value.length - 1);
}

/**
 * The CSS the host writes from a page's checked tokens: each target's rule
 * at zero specificity under the page root (or as the anatomy places it), in
 * the anatomy's order, its wide values in the wide media query and a grid's
 * columns only where they fit. Values were checked by type: nothing here is
 * a theme's text.
 */
export function privateTokenCss(page: PrivatePageKey, tokens: PrivateTokens[PrivatePageKey], unitHooks: ReadonlySet<string> = new Set()): string {
  if (!tokens) return "";
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
      const parsed = token.schema.safeParse(value);
      if (!parsed.success) continue;
      const selectors = (token.on ?? [""]).map((suffix) => `:where(${selector})${suffix}`).join(",");
      const columns = name === "columns" || name === "columns-wide";
      const floor = unitHooks.has(target.slice(1)) ? UNIT_TRACK_FLOOR : PAGE_TRACK_FLOOR;
      const rule = columns
        ? `${selectors}{grid-template-columns:${tracks(parsed.data as Tracks, floor)};grid-auto-flow:row}`
        : `${selectors}{${token.write(parsed.data as never)}}`;
      if (columns) {
        // Measured on the box that holds the grid (a size container), never the viewport alone.
        const fit = Math.max(tracksFit(parsed.data as Tracks, gap, floor), name === "columns-wide" ? 640 : 0);
        narrow.push(`:where(${root} :has(> ${selector.slice(root.length + 1)})){container-type:inline-size}@container (min-width:${fit}px){${rule}}`);
      } else {
        (token.wide ? wide : narrow).push(rule);
      }
      // Text on the target's surface (itself and inside) reads the carried colour; a reset falls back to its own.
      for (const [className, property, fallback] of CARRIED[name as PrivateTokenName] ?? []) {
        narrow.push(`:where(${selector}):where(${className}),:where(${selector}) :where(${className}){color:var(${property},var(${fallback}))}`);
      }
    }
  }
  return `${narrow.join("")}${wide.length > 0 ? `@media ${PRIVATE_WIDE_MEDIA}{${wide.join("")}}` : ""}`;
}
