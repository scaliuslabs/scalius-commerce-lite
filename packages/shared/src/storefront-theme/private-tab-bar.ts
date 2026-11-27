// The phone tab bar's look (`privatePages.tokens.tabBar`): one declaration in the theme document styles the store's
// bar (`blocks.mobileNav` `bottom-tabs`) on every page that draws it, public and private (docs: private-pages.md,
// "The phone tab bar"). Typed tokens only, checked here like every private page's: each colour a palette role, a hex or
// one per scheme, each read on what it stands on in every palette buyers see; sizes within the bar's own bounds.
//
// Precedence: the compiled rules have zero specificity and are written after the store's own bar rules (also zero
// specificity), so they replace the store's defaults; on a public page any rule of the theme's own stylesheet outranks
// both. On a buyer's private page no theme stylesheet loads, so the tokens are the bar's look there.
import { PRIVATE_PAGES, type PrivateTokenName } from "./private-anatomy";
import { storefrontThemeContrast, storefrontThemeMix, type StorefrontThemeColors } from "./contrast";
import { PRIVATE_CONTRAST_FLOOR, PRIVATE_MARK_CONTRAST_FLOOR, PRIVATE_TOKEN_SPECS, type PrivatePalette, type PrivateTokenIssue } from "./private-tokens";

import { PRIVATE_TAB_BAR_BOUNDS, PRIVATE_TAB_BAR_CHOICES, PRIVATE_TAB_BAR_DEFAULTS, PRIVATE_TAB_BAR_LABEL, PRIVATE_TAB_BAR_LIMITS } from "./private-tab-bar-limits";

export { PRIVATE_TAB_BAR_BOUNDS, PRIVATE_TAB_BAR_CHOICES, PRIVATE_TAB_BAR_DEFAULTS, PRIVATE_TAB_BAR_LABEL, PRIVATE_TAB_BAR_LIMITS };
const BLUR_BLEED = PRIVATE_TAB_BAR_LIMITS.blurBleed;

const ROOT = '[data-private="tab-bar"]';
const SELECTORS = {
  bar: ROOT,
  tab: `${ROOT} [data-part="tab"]`,
  current: `${ROOT} [data-part="tab"][aria-current]`,
  label: `${ROOT} [data-part="tab-label"]`,
  icon: `${ROOT} [data-part="tab-icon"]`,
  currentIcon: `${ROOT} [data-part="tab"][aria-current] [data-part="tab-icon"]`,
  badge: `${ROOT} [data-part="tab-badge"]`,
} as const;

type Values = Partial<Record<PrivateTokenName, unknown>>;
type Colour = string | { light: string; dark: string };

const issue = (path: Array<string | number>, reason: PrivateTokenIssue["reason"], message: string): PrivateTokenIssue => ({ path: ["privatePages", "tokens", "tabBar", ...path], reason, message });

/** A colour value as one palette draws it. */
function resolve(value: unknown, palette: PrivatePalette): string {
  const one = typeof value === "object" && value !== null ? (value as Record<string, string>)[palette.scheme]! : String(value);
  return one.startsWith("#") ? one : palette.colors[one as keyof StorefrontThemeColors] ?? one;
}

/** The tokens by name and value: names the anatomy lists, values in each token's type and the bar's bounds. */
function validated(tokens: Record<string, Values>): { valid: Record<string, Values>; issues: PrivateTokenIssue[] } {
  const styles = PRIVATE_PAGES.tabBar.styles;
  const issues: PrivateTokenIssue[] = [];
  const valid: Record<string, Values> = {};
  for (const [target, values] of Object.entries(tokens)) {
    const style = Object.hasOwn(styles, target) ? styles[target] : undefined;
    if (!style) {
      issues.push(issue([target], "unknown_style", `${target} is not a style target of the phone tab bar; it takes ${Object.keys(styles).join(", ")}.`));
      continue;
    }
    valid[target] = {};
    for (const [token, value] of Object.entries(values ?? {})) {
      const name = token as PrivateTokenName;
      if (!style.tokens.includes(name)) {
        issues.push(issue([target, token], "unknown_token", `${target} takes ${style.tokens.join(", ")}; not ${token}.`));
        continue;
      }
      const bounds = (PRIVATE_TAB_BAR_BOUNDS as Record<string, readonly [number, number]>)[`${target}.${token}`];
      const choices = (PRIVATE_TAB_BAR_CHOICES as Record<string, readonly string[]>)[`${target}.${token}`];
      const ok = choices ? choices.includes(String(value)) && typeof value === "string"
        : bounds ? Number.isInteger(value) && (value as number) >= bounds[0] && (value as number) <= bounds[1]
          : PRIVATE_TOKEN_SPECS[name].schema.safeParse(value).success;
      if (!ok) {
        issues.push(issue([target, token], "token_value", choices ? `${target} ${token}: on the bar, one of ${choices.join(", ")}.` : bounds ? `${target} ${token}: a whole number of pixels from ${bounds[0]} to ${bounds[1]}.` : `${target} ${token}: not a value this token takes.`));
        continue;
      }
      valid[target]![name] = value;
    }
  }
  return { valid, issues };
}

/** One palette's colours of the bar: each token, else the store's own. */
function coloursOf(tokens: Record<string, Values>, palette: PrivatePalette) {
  const pick = (target: string, token: PrivateTokenName, fallback: Colour) => resolve(tokens[target]?.[token] ?? fallback, palette);
  const bar = pick("bar", "background", "background");
  const label = pick("label", "text", "muted-foreground");
  const current = pick("current", "text", "foreground");
  const chip = tokens.icon?.background !== undefined ? pick("icon", "background", "background") : null;
  const currentChip = tokens.current?.background !== undefined ? pick("current", "background", "background") : chip;
  return {
    bar, label, current, chip, currentChip,
    edge: pick("bar", "border", "border"),
    chipEdge: tokens.icon?.border !== undefined ? pick("icon", "border", "border") : null,
    ring: tokens.current?.ring !== undefined ? pick("current", "ring", "foreground") : null,
    badge: pick("badge", "background", "destructive"),
    badgeText: pick("badge", "text", "destructive-foreground"),
    // What the label and icons stand on: the bar's colour, and under a blurred bar the colour with what shows through
    // it at its lightest and its darkest.
    under: tokens.bar?.backdrop === "solid" ? [bar] : [storefrontThemeMix(bar, "#ffffff", BLUR_BLEED), storefrontThemeMix(bar, "#000000", BLUR_BLEED)],
  };
}

/**
 * The weights the bar draws, the one source of the CSS and of the check: every tab's (`label.weight`, else the store's),
 * the current tab's (`current.weight`, else the store's own current weight, which the CSS writes too wherever it writes
 * every tab's: the tabs' rule would otherwise reach the current tab).
 */
export function privateTabBarWeights(tokens: Record<string, Values>): { tab: number; current: number; writeTab: boolean; writeCurrent: boolean } {
  const tab = tokens.label?.weight;
  const current = tokens.current?.weight;
  return {
    tab: Number(tab ?? PRIVATE_TAB_BAR_DEFAULTS.labelWeight),
    current: Number(current ?? PRIVATE_TAB_BAR_DEFAULTS.currentWeight),
    writeTab: tab !== undefined,
    writeCurrent: current !== undefined || tab !== undefined,
  };
}

const worst = (colour: string, backs: readonly string[]) => Math.min(...backs.map((back) => storefrontThemeContrast(colour, back)));
const ratio = (value: number) => `${value.toFixed(2)}:1`;

/** Each colour read on what it stands on, in one palette. */
function contrastIssues(tokens: Record<string, Values>, palette: PrivatePalette): PrivateTokenIssue[] {
  const c = coloursOf(tokens, palette);
  const where = `in the ${palette.scheme} colours`;
  const out: PrivateTokenIssue[] = [];
  const need = (path: Array<string>, value: number, floor: number, what: string) => {
    if (value < floor) out.push(issue(path, "contrast", `${what} reads ${ratio(value)} ${where}; it needs ${floor}:1.`));
  };
  need(["label", "text"], worst(c.label, c.under), PRIVATE_CONTRAST_FLOOR, "A tab's label on the bar");
  need(["current", "text"], worst(c.current, c.under), PRIVATE_CONTRAST_FLOOR, "The current tab's label on the bar");
  // The icon is drawn in its tab's words' colour: a graphic, 3:1 on its chip (or on the bar without one).
  need(["icon", "background"], worst(c.label, c.chip ? [c.chip] : c.under), PRIVATE_MARK_CONTRAST_FLOOR, "A tab's icon on its chip");
  need(["current", "background"], worst(c.current, c.currentChip ? [c.currentChip] : c.under), PRIVATE_MARK_CONTRAST_FLOOR, "The current tab's icon on its chip");
  need(["badge", "text"], storefrontThemeContrast(c.badgeText, c.badge), PRIVATE_CONTRAST_FLOOR, "The cart count on its badge");
  need(["badge", "background"], worst(c.badge, c.under), PRIVATE_MARK_CONTRAST_FLOOR, "The cart count's badge on the bar");
  // The current tab is told apart by more than its hue (WCAG 1.4.1, G183), by one of: its words 3:1 apart from the
  // others'; a ring at least 2px wide reading 3:1 on the bar; a weight at least 200 heavier; a chip at least 4px larger
  // (both chips drawn). A cue of 1.5:1 words or one weight step is a hue and a shade: refused.
  const limits = PRIVATE_TAB_BAR_LIMITS;
  const ringWidth = Number(tokens.current?.["ring-width"] ?? 0);
  const words = storefrontThemeContrast(c.current, c.label);
  const cues = [
    words >= limits.wordsApart,
    Boolean(c.ring) && ringWidth >= limits.ringWidth && worst(c.ring!, c.under) >= PRIVATE_MARK_CONTRAST_FLOOR,
    privateTabBarWeights(tokens).current - privateTabBarWeights(tokens).tab >= limits.weightStep,
    tokens.icon?.background !== undefined && tokens.current?.background !== undefined && Number(tokens.current?.padding ?? tokens.icon?.padding ?? 0) - Number(tokens.icon?.padding ?? 0) >= limits.chipStep,
  ];
  if (!cues.some(Boolean)) out.push(issue(["current"], "contrast", `The current tab is told apart by its hue alone ${where}: give it words at least ${limits.wordsApart}:1 apart from the others' (${ratio(words)} now), a ring at least ${limits.ringWidth}px wide reading 3:1 on the bar, a weight at least ${limits.weightStep} heavier, or a chip at least ${limits.chipStep}px larger than theirs.`));
  return out;
}

/** The bar holds a tab whole: its largest icon box, the gap and its label's lines. */
function heightIssues(tokens: Record<string, Values>): PrivateTokenIssue[] {
  const n = (target: string, token: PrivateTokenName, fallback: number) => Number(tokens[target]?.[token] ?? fallback);
  const icon = n("icon", "size", PRIVATE_TAB_BAR_DEFAULTS.iconSize);
  const edge = n("icon", "border-width", 0);
  const box = (padding: number, ring: number) => icon + 2 * padding + 2 * edge + 2 * ring;
  const tallest = Math.max(box(n("icon", "padding", 0), 0), box(n("current", "padding", n("icon", "padding", 0)), n("current", "ring-width", 0)));
  const lines = tokens.label?.clamp === "1" ? 1 : 2;
  const size = n("label", "size", PRIVATE_TAB_BAR_DEFAULTS.labelSize);
  const needed = Math.ceil(tallest + PRIVATE_TAB_BAR_DEFAULTS.gap + size * (lines * PRIVATE_TAB_BAR_LABEL.leading + 2 * PRIVATE_TAB_BAR_LABEL.room));
  const height = n("bar", "height", PRIVATE_TAB_BAR_DEFAULTS.height);
  return height >= needed ? [] : [issue(["bar", "height"], "token_value", `The bar is ${height}px; a tab needs ${needed}px (its ${tallest}px icon, the gap and ${lines === 1 ? "a line" : "two lines"} of its label), or a label would be cut.`)];
}

const px = (value: unknown) => `${Number(value)}px`;

/** The rules (zero specificity: `:where`), the colours per palette (the dark ones under the dark scheme). */
function css(tokens: Record<string, Values>, palettes: readonly PrivatePalette[]): string {
  const rule = (selector: string, declarations: Array<string | false | null>) => {
    const body = declarations.filter(Boolean).join(";");
    return body ? `:where(${selector}){${body}}` : "";
  };
  const { bar = {}, label = {}, current = {}, icon = {} } = tokens;
  const weights = privateTabBarWeights(tokens);
  const shape = [
    bar.height !== undefined ? `:where(:root){--mobile-tabs-height:${px(bar.height)}}` : "",
    rule(SELECTORS.label, [
      label.size !== undefined && `font-size:${px(label.size)}`,
      label.case !== undefined && `text-transform:${label.case === "uppercase" ? "uppercase" : "none"}`,
      label.tracking !== undefined && `letter-spacing:${({ normal: "normal", wide: "0.04em", wider: "0.08em" } as Record<string, string>)[String(label.tracking)]}`,
      label.clamp === "1" && "display:block;white-space:nowrap;-webkit-line-clamp:none;text-overflow:ellipsis",
    ]),
    rule(SELECTORS.tab, [weights.writeTab && `font-weight:${weights.tab}`]),
    rule(SELECTORS.current, [weights.writeCurrent && `font-weight:${weights.current}`]),
    // An icon's box holds its chip's room and edge (border-box, whatever box the host's other rules give it).
    ...(() => {
      if (icon.size === undefined && icon.padding === undefined && icon["border-width"] === undefined && current.padding === undefined) return [rule(SELECTORS.icon, [icon.radius !== undefined && `border-radius:${px(icon.radius)}`])];
      const size = Number(icon.size ?? PRIVATE_TAB_BAR_DEFAULTS.iconSize);
      const edge = Number(icon["border-width"] ?? 0);
      const box = (padding: number) => `box-sizing:border-box;inline-size:${size + 2 * padding + 2 * edge}px;block-size:${size + 2 * padding + 2 * edge}px;padding:${padding}px`;
      return [
        rule(SELECTORS.icon, [box(Number(icon.padding ?? 0)), icon.radius !== undefined && `border-radius:${px(icon.radius)}`, edge > 0 && `border:${edge}px solid transparent`]),
        current.padding !== undefined ? rule(SELECTORS.currentIcon, [box(Number(current.padding))]) : "",
      ];
    })(),
    bar.backdrop === "solid" ? rule(SELECTORS.bar, ["-webkit-backdrop-filter:none", "backdrop-filter:none"]) : "",
  ].join("");
  const colours = palettes.map((palette, index) => {
    const c = coloursOf(tokens, palette);
    const ringWidth = Number(current["ring-width"] ?? 0);
    const rules = [
      rule(SELECTORS.bar, [bar.backdrop === "solid" ? `background-color:${c.bar}` : `background-color:color-mix(in srgb,${c.bar} 94%,transparent)`, `border-top-color:${c.edge}`]),
      rule(SELECTORS.tab, [`color:${c.label}`]),
      rule(SELECTORS.current, [`color:${c.current}`]),
      rule(SELECTORS.icon, [c.chip && `background-color:${c.chip}`, c.chipEdge && `border-color:${c.chipEdge}`]),
      rule(SELECTORS.currentIcon, [current.background !== undefined && `background-color:${c.currentChip}`, c.ring && ringWidth > 0 && `box-shadow:0 0 0 ${ringWidth}px ${c.ring}`]),
      rule(SELECTORS.badge, [`background-color:${c.badge}`, `color:${c.badgeText}`, `box-shadow:0 0 0 2px ${c.bar}`]),
    ].join("");
    // The first palette is the page's; a second (dark) one draws under the dark scheme.
    return index === 0 ? rules : `@media screen{:where([data-color-scheme="dark"]){${rules}}}`;
  }).join("");
  return `${shape}${colours}`;
}

/**
 * The bar's tokens compiled: checked by name, type and the bar's bounds, the bar's height against what a tab needs,
 * every colour on what it stands on in each palette, then the CSS. Nothing for no tokens: the store's own bar.
 */
export function compileTabBarTokens(tokens: Record<string, Values> | undefined, palettes: readonly PrivatePalette[]): { issues: PrivateTokenIssue[]; css: string } {
  if (!tokens || Object.keys(tokens).length === 0) return { issues: [], css: "" };
  const { valid, issues } = validated(tokens);
  if (issues.length > 0) return { issues, css: "" };
  const checked = [...heightIssues(valid), ...palettes.flatMap((palette) => contrastIssues(valid, palette))];
  return checked.length > 0 ? { issues: checked, css: "" } : { issues: [], css: css(valid, palettes) };
}
