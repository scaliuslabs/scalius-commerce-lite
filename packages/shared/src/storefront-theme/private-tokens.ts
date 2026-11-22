// A theme's look for the host parts of a private page: typed tokens, never
// selectors (docs: packages/plugin-sdk/docs/private-pages.md).
//
// Each page names its style targets (private-anatomy.ts `styles`) and the
// tokens each takes; a theme's layout node takes PRIVATE_LAYOUT_TOKENS by its
// hook (`@<hook>`). A theme supplies values only, checked by type at save:
// - colours are a palette role (`card`, `primary`) or an opaque `#rrggbb`;
// - lengths are whole pixels within each token's bounds (text 12 to 40);
// - choices (weight, case, shadow, font role, …) come from a closed list;
// - no value is text CSS reads as code (no var(), calc(), url() or words).
// The host writes every rule from them, under the page root, and keeps
// every text it draws above the contrast floor (WCAG AA, 4.5:1) against
// what is beneath it, in every palette buyers can see: a token set that
// would make a part unreadable is refused (`contrast`).
import { z } from "zod";
import { STOREFRONT_THEME_COLOR_KEYS, storefrontThemeContrast, type StorefrontThemeColors } from "./contrast";
import {
  PRIVATE_HOOK_PATTERN,
  PRIVATE_LAYOUT_TOKENS,
  PRIVATE_PAGES,
  type PrivateNode,
  type PrivatePageKey,
  type PrivatePageSpec,
  type PrivateStyleSpec,
  type PrivateTokenName,
} from "./private-anatomy";

/** The contrast floor of every text the host draws (WCAG 1.4.3 AA). */
export const PRIVATE_CONTRAST_FLOOR = 4.5;

const HEX = /^#[0-9a-f]{6}$/;
const colorSchema = z.union([z.enum(STOREFRONT_THEME_COLOR_KEYS), z.string().regex(HEX, "An opaque colour, #rrggbb in lowercase, or a palette role.")]);
type ColorValue = z.infer<typeof colorSchema>;
const gradientSchema = z.object({
  shape: z.enum(["linear", "radial"]),
  angle: z.number().int().min(0).max(360).optional(),
  from: colorSchema,
  to: colorSchema,
}).strict();
const trackSchema = z.union([z.enum(["auto", "min-content", "1fr", "2fr", "3fr", "4fr"]), z.number().int().min(24).max(480)]);
const tracksSchema = z.array(trackSchema).min(1).max(4);

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
const gradient = (value: z.infer<typeof gradientSchema>) => value.shape === "linear"
  ? `linear-gradient(${value.angle ?? 180}deg,${color(value.from)},${color(value.to)})`
  : `radial-gradient(circle at top,${color(value.from)},${color(value.to)})`;
const tracks = (value: z.infer<typeof tracksSchema>) => value.map((track) => typeof track === "number" ? `${track}px` : /fr$/.test(track) ? `minmax(0,${track})` : track).join(" ");
const choice = <T extends string>(values: Record<T, string>): Pick<TokenSpec, "schema" | "write"> => ({
  schema: z.enum(Object.keys(values) as [T, ...T[]]),
  write: (value: T) => values[value],
});

/** The text a target draws as its own colour, as the host's markup marks it. */
const OWN_TEXT = ["", " :is(.text-foreground,.text-card-foreground)"] as const;

export const PRIVATE_TOKEN_SPECS: Record<PrivateTokenName, TokenSpec> = {
  background: { schema: colorSchema, write: (value: ColorValue) => `background-color:${color(value)}` },
  gradient: { schema: gradientSchema, write: (value: z.infer<typeof gradientSchema>) => `background-image:${gradient(value)}` },
  text: { schema: colorSchema, write: (value: ColorValue) => `color:${color(value)}`, on: OWN_TEXT },
  muted: { schema: colorSchema, write: (value: ColorValue) => `color:${color(value)}`, on: [" .text-muted-foreground"] },
  link: { schema: colorSchema, write: (value: ColorValue) => `color:${color(value)}`, on: [" .text-primary"] },
  error: { schema: colorSchema, write: (value: ColorValue) => `color:${color(value)}`, on: [" .text-destructive"] },
  border: { schema: colorSchema, write: (value: ColorValue) => `border-color:${color(value)}`, on: ["", " :is(.border-border,.divide-border>*)"] },
  "border-width": { schema: px(0, 4), write: (value: number) => `border-width:${value}px` },
  "border-style": choice({ solid: "border-style:solid", dashed: "border-style:dashed", dotted: "border-style:dotted", none: "border-style:none" }),
  radius: { schema: px(0, 32), write: (value: number) => `border-radius:${value}px` },
  shadow: choice({
    none: "box-shadow:none",
    sm: "box-shadow:0 1px 2px rgb(0 0 0 / 0.12)",
    md: "box-shadow:0 4px 12px rgb(0 0 0 / 0.18)",
    lg: "box-shadow:0 12px 32px rgb(0 0 0 / 0.28)",
  }),
  padding: { schema: px(0, 48), write: (value: number) => `padding:${value}px` },
  gap: { schema: px(0, 48), write: (value: number) => `gap:${value}px` },
  font: choice({ body: "font-family:var(--theme-font-body)", heading: "font-family:var(--theme-font-heading)" }),
  weight: choice({ 400: "font-weight:400", 500: "font-weight:500", 600: "font-weight:600", 700: "font-weight:700", 800: "font-weight:800" }),
  size: { schema: px(12, 40), write: (value: number) => `font-size:${value}px`, on: OWN_TEXT },
  case: choice({ none: "text-transform:none", uppercase: "text-transform:uppercase" }),
  tracking: choice({ normal: "letter-spacing:normal", wide: "letter-spacing:0.04em", wider: "letter-spacing:0.08em" }),
  align: choice({ start: "text-align:start", center: "text-align:center", end: "text-align:end" }),
  // At least two lines: a title is never cut to one.
  clamp: choice({
    none: "display:block;-webkit-line-clamp:none;overflow:visible",
    2: "display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden",
    3: "display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden",
  }),
  columns: { schema: tracksSchema, write: (value: z.infer<typeof tracksSchema>) => `grid-template-columns:${tracks(value)};grid-auto-flow:row` },
  "columns-wide": { schema: tracksSchema, write: (value: z.infer<typeof tracksSchema>) => `grid-template-columns:${tracks(value)};grid-auto-flow:row`, wide: true },
  width: { schema: px(40, 240), write: (value: number) => `inline-size:${value}px` },
  height: { schema: px(40, 320), write: (value: number) => `block-size:${value}px` },
  "width-wide": { schema: px(40, 240), write: (value: number) => `inline-size:${value}px`, wide: true },
  "height-wide": { schema: px(40, 320), write: (value: number) => `block-size:${value}px`, wide: true },
  fit: { ...choice({ contain: "object-fit:contain", cover: "object-fit:cover" }), on: [" img"] },
  "max-width": { schema: px(480, 1600), write: (value: number) => `max-inline-size:${value}px` },
};

/** Where a phone ends (the store's `sm`). */
export const PRIVATE_WIDE_MEDIA = "(min-width:40rem)";

/** `privatePages.tokens`: per page, per style target (or `@<layout hook>`), per token, a value. */
// Names are checked by the compile (`unknown_style`, `unknown_token`) so the schema stays small.
export const privateTokensSchema = z.record(
  z.string().regex(/^[a-zA-Z]{1,24}$/),
  z.record(z.string().regex(/^@?[a-z][a-z0-9-]{0,40}$/), z.record(z.string().regex(/^[a-z][a-z-]{0,23}$/), z.unknown())),
).refine((tokens) => Object.keys(tokens).every((page) => page in PRIVATE_PAGES), "Tokens are set per private page: cart.") as unknown as z.ZodType<PrivateTokens>;
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

interface Resolved { colors: string[]; touched: boolean }

/** Each page's tokens checked: names, values by type, and every text the host draws against what is beneath it. */
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
      : spec.styles[target]?.tokens;
    if (!allowed) {
      issues.push({ path: base, reason: "unknown_style", message: layout
        ? `${target}: no layout node of this page's arrangement has the hook ${target.slice(1)}.`
        : `${target} is not a style target of ${page}; it takes ${Object.keys(spec.styles).join(", ") || "none"}.` });
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

function contrastIssues(page: PrivatePageKey, spec: PrivatePageSpec, tokens: Record<string, Partial<Record<PrivateTokenName, unknown>>>, context: PrivateTokenContext): PrivateTokenIssue[] {
  const issues: PrivateTokenIssue[] = [];
  const seen = new Set<string>();
  const unitRoot = Object.entries(spec.styles).find(([, style]) => style.selector === '[data-part="line"]')?.[0];
  for (const palette of context.palettes) {
    const own = (target: string): Resolved | null => {
      const values = tokens[target];
      const fill = values?.gradient as z.infer<typeof gradientSchema> | undefined;
      if (fill) return { colors: [hex(fill.from, palette), hex(fill.to, palette)], touched: true };
      if (values?.background) return { colors: [hex(values.background as ColorValue, palette)], touched: true };
      return null;
    };
    const pageBackground = (): Resolved => own("page") ?? { colors: [palette.background], touched: false };
    const beneath = (style: PrivateStyleSpec): Resolved => {
      if (style.on) return background(style.on);
      if (style.part) {
        const trail = ancestors(style.item ? context.items[style.item] ?? [] : context.layout, style.part) ?? [];
        for (const hook of trail) {
          const found = own(`@${hook}`);
          if (found) return found;
        }
        if (style.item && unitRoot) return background(unitRoot);
      }
      return pageBackground();
    };
    const background = (target: string): Resolved => {
      const style = spec.styles[target]!;
      return own(target) ?? (style.surface !== "under" ? { colors: [palette[style.surface]], touched: false } : beneath(style));
    };
    // A text role as it reads inside `target`: its own token, else what the target it is drawn in sets.
    const text = (target: string, role: string, first: boolean): Resolved => {
      const style = spec.styles[target]!;
      const values = tokens[target];
      if (first && values?.text) return { colors: [hex(values.text as ColorValue, palette)], touched: true };
      const inner = role === "muted-foreground" ? values?.muted : role === "primary" ? values?.link : role === "destructive" ? values?.error : undefined;
      if (inner) return { colors: [hex(inner as ColorValue, palette)], touched: true };
      if ((role === "foreground" || role === "card-foreground") && values?.text) return { colors: [hex(values.text as ColorValue, palette)], touched: true };
      const parent = style.on ?? (style.item ? unitRoot : undefined);
      if (parent && parent !== target && ["foreground", "card-foreground", "muted-foreground", "primary", "destructive"].includes(role)) return text(parent, role, false);
      return { colors: [palette[role as keyof StorefrontThemeColors]], touched: false };
    };
    const check = (label: string, path: Array<string | number>, texts: Resolved[], under: Resolved) => {
      for (const ink of texts) {
        if (!ink.touched && !under.touched) continue;
        for (const fore of ink.colors) for (const back of under.colors) {
          const ratio = storefrontThemeContrast(fore, back);
          const key = `${label}|${fore}|${back}`;
          if (ratio >= PRIVATE_CONTRAST_FLOOR || seen.has(key)) continue;
          seen.add(key);
          issues.push({ path, reason: "contrast", message: `${label}: text ${fore} on ${back} is ${ratio.toFixed(2)}:1, under the ${PRIVATE_CONTRAST_FLOOR}:1 a buyer needs to read it.` });
        }
      }
    };
    for (const [target, style] of Object.entries(spec.styles)) {
      if (style.text.length === 0) continue;
      check(target, ["privatePages", "tokens", page, target], style.text.map((role, index) => text(target, role, index === 0)), background(target));
    }
    // A layout node's background is beneath whatever it holds that has no colour of its own.
    for (const target of Object.keys(tokens).filter((key) => key.startsWith("@"))) {
      const under = own(target);
      if (under) check(target, ["privatePages", "tokens", page, target], [{ colors: [palette.foreground, palette["muted-foreground"]], touched: false }], under);
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

/**
 * The CSS the host writes from a page's checked tokens: each target's rule
 * under the page root (or as the anatomy places it), its wide values in
 * the wide media query. Values were checked by type: nothing here is a
 * theme's text.
 */
export function privateTokenCss(page: PrivatePageKey, tokens: PrivateTokens[PrivatePageKey]): string {
  if (!tokens) return "";
  const spec: PrivatePageSpec = PRIVATE_PAGES[page];
  const root = `[data-private="${spec.root}"]`;
  const narrow: string[] = [];
  const wide: string[] = [];
  const order = [...Object.keys(spec.styles).filter((target) => tokens[target]), ...Object.keys(tokens).filter((target) => target.startsWith("@")).sort()];
  for (const target of order) {
    const style = spec.styles[target];
    const selector = style
      ? (style.absolute ? style.selector : style.selector ? `${root} ${style.selector}` : root)
      : `${root} [data-layout][data-hook="${target.slice(1)}"]`;
    for (const [name, value] of Object.entries(tokens[target] ?? {})) {
      const token = PRIVATE_TOKEN_SPECS[name as PrivateTokenName];
      const parsed = token.schema.safeParse(value);
      if (!parsed.success) continue;
      const selectors = (token.on ?? [""]).map((suffix) => `${selector}${suffix}`).join(",");
      (token.wide ? wide : narrow).push(`${selectors}{${token.write(parsed.data as never)}}`);
    }
  }
  return `${narrow.join("")}${wide.length > 0 ? `@media ${PRIVATE_WIDE_MEDIA}{${wide.join("")}}` : ""}`;
}
