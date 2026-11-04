/**
 * The colours a merchant picks; each writes every token that shares its
 * role, and every colour no field shows is made from them (fitThemeColors),
 * so any readable choice saves. A theme shown dark (a dark or device scheme,
 * or the buyer's switch) has a second set, the dark colours, edited the same
 * way.
 */
import type { SettingBindings } from "@scalius/shared/storefront-theme/bindings";
import {
  STOREFRONT_BANGLA_FONTS,
  STOREFRONT_BENGALI_SYSTEM_FONT,
  STOREFRONT_FONTS,
  STOREFRONT_PRODUCT_MODULES,
  STOREFRONT_TEMPLATES,
  STOREFRONT_THEME_COLOR_KEYS,
  STOREFRONT_THEME_DOCUMENT_VERSION,
  STOREFRONT_THEME_MAX_MUTED_CHROMA,
  STOREFRONT_THEME_MIN_CONTRAST,
  STOREFRONT_THEME_MIN_MUTED_ERROR_DISTANCE,
  STOREFRONT_TYPE_PAIRING_SPECS,
  applyStorefrontAppTemplate,
  isStorefrontThemeHexColor,
  listStorefrontThemeDocumentContrastProblems,
  canonicalStorefrontLink,
  readStorefrontAppTemplateTheme,
  resolveStorefrontTheme,
  storefrontBlockSwitch,
  storefrontBlockValue,
  storefrontContrastRoleToken,
  storefrontDarkColorsAreMade,
  storefrontThemeChroma,
  storefrontThemeColorDistance,
  storefrontThemeContrast,
  storefrontThemeFieldBorder,
  storefrontThemeLab,
  storefrontThemeLuminance,
  storefrontThemeMix,
  storefrontThemeColorsAreDark,
  storefrontDarkPalette,
  storefrontTemplateTheme,
  storefrontThemeShowsDarkColors,
  storefrontThemeLook,
  storefrontThemeWithContent,
  type ResolvedStorefrontTheme,
  type StoreShape,
  type StorefrontAppTemplateTheme,
  type StorefrontBlockSlot,
  type StorefrontColorScheme,
  type StorefrontThemeColorSet,
  type StorefrontProductAppBlock,
  type StorefrontProductModule,
  type StorefrontSection,
  type StorefrontSkinRef,
  type StorefrontTemplateId,
  type StorefrontThemeColorKey,
  type StorefrontThemeDocument,
  type StorefrontThemeFallback,
  type StorefrontThemeSkinUnit,
  type StorefrontThemeTokens,
  type StorefrontTypePairing,
} from "@scalius/shared/storefront-theme";
import { PLUGIN_PRODUCT_BLOCKS_MAX } from "@scalius/shared/plugins/storefront";
import { STOREFRONT_SKIN_UNITS, storefrontComponentProductSlot } from "@scalius/shared/plugins/storefront-protocol";
import type { ThemeApp, ThemeAppBlock, ThemeAppSkin } from "~/lib/api-query-options/online-store";
import { appValuesInvalid, type AppSettingValues } from "./schema-form/app-settings";
import { sameFormValue } from "~/lib/form-values";

export const COLOR_ROLES = {
  background: ["background"],
  text: ["foreground", "card-foreground", "popover-foreground", "secondary-foreground"],
  buttons: ["primary", "ring"],
  buttonText: ["primary-foreground"],
  highlight: ["accent"],
  highlightText: ["accent-foreground"],
} as const satisfies Record<string, readonly StorefrontThemeColorKey[]>;

export type ColorRole = keyof typeof COLOR_ROLES;

/** The token each colour field shows. */
export const COLOR_ROLE_TOKEN: Record<ColorRole, StorefrontThemeColorKey> = {
  background: "background",
  text: "foreground",
  buttons: "primary",
  buttonText: "primary-foreground",
  highlight: "accent",
  highlightText: "accent-foreground",
};

/** DOM id of each colour field, so save errors and contrast problems mark it. */
export const COLOR_FIELD_IDS: Record<ColorRole, string> = {
  background: "theme-color-background",
  text: "theme-color-text",
  buttons: "theme-color-buttons",
  buttonText: "theme-color-button-text",
  highlight: "theme-color-highlight",
  highlightText: "theme-color-highlight-text",
};

/** DOM id of a colour field in one set (the dark colours' fields are `theme-dark-color-…`). */
export function colorFieldId(role: ColorRole, set: StorefrontThemeColorSet): string {
  return set === "colors" ? COLOR_FIELD_IDS[role] : COLOR_FIELD_IDS[role].replace("theme-color-", "theme-dark-color-");
}

/** The colour sets buyers can see: the colours, and the dark colours while the theme shows them. */
export function themeColorSets(theme: StorefrontThemeDocument): StorefrontThemeColorSet[] {
  return storefrontThemeShowsDarkColors(theme.tokens) ? ["colors", "darkColors"] : ["colors"];
}

/**
 * The document with the dark colours shown (a scheme, or the buyer's
 * switch) or not. The first time they show, dark colours made from the
 * colours are stored with it (`storefrontDarkPalette`), so the store looks
 * right at once; the merchant's own dark colours are kept from then on.
 */
function withDarkColorsStored(theme: StorefrontThemeDocument, tokens: Partial<StorefrontThemeTokens>): StorefrontThemeDocument {
  const next = { ...theme.tokens, ...tokens };
  const darkColors = next.darkColors ?? (storefrontThemeShowsDarkColors(next) ? storefrontDarkPalette(next.colors) : null);
  return { ...theme, tokens: { ...next, darkColors } };
}

/** Whether the dark colours are the ones made from the colours: they follow the colours until the merchant edits them. */
function darkColorsFollowColors(theme: StorefrontThemeDocument): boolean {
  const dark = theme.tokens.darkColors;
  return dark !== null && storefrontDarkColorsAreMade(theme.tokens.colors, dark);
}

export function setColorScheme(theme: StorefrontThemeDocument, colorScheme: StorefrontColorScheme): StorefrontThemeDocument {
  return withDarkColorsStored(theme, { colorScheme });
}

export function setColorSchemeToggle(theme: StorefrontThemeDocument, colorSchemeToggle: boolean): StorefrontThemeDocument {
  return withDarkColorsStored(theme, { colorSchemeToggle });
}

function hexChannels(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function channelsHex(channels: readonly number[]): string {
  return `#${channels.map((channel) => Math.min(255, Math.max(0, Math.round(channel))).toString(16).padStart(2, "0")).join("")}`;
}

/** The colours no field shows: made from the six fields (fitThemeColors). */
const SURFACE_TOKENS = ["card", "popover", "secondary", "muted", "border", "input"] as const satisfies readonly StorefrontThemeColorKey[];

/**
 * Where `color` sits on the line from `from` to `to` (0 at `from`, 1 at `to`,
 * negative beyond `from`), and what is left over off the line (a tint):
 * `from + weight * (to - from) + rest` is `color` again.
 */
function placeOnLine(color: string, from: string, to: string): { weight: number; rest: number[] } {
  const [c, a, b] = [hexChannels(color), hexChannels(from), hexChannels(to)];
  const span = b.map((channel, index) => channel - a[index]!);
  const length = span.reduce((sum, channel) => sum + channel * channel, 0);
  const weight = length === 0 ? 0 : span.reduce((sum, channel, index) => sum + channel * (c[index]! - a[index]!), 0) / length;
  return { weight, rest: c.map((channel, index) => channel - a[index]! - weight * span[index]!) };
}

/** A colour placed on another line the way `placeOnLine` measured it. */
function onLine(place: { weight: number; rest: readonly number[] }, from: string, to: string): string {
  const [a, b] = [hexChannels(from), hexChannels(to)];
  return channelsHex(a.map((channel, index) => channel + place.weight * (b[index]! - channel) + place.rest[index]!));
}

const reads = (text: string, surface: string) => storefrontThemeContrast(text, surface) >= STOREFRONT_THEME_MIN_CONTRAST;

/** `color` moved toward `toward` until every text reads on it (`color` itself when none has to). */
function untilRead(color: string, texts: readonly string[], toward: string): string {
  for (let step = 0; step <= 20; step += 1) {
    const candidate = storefrontThemeMix(color, toward, step / 20);
    if (texts.every((text) => reads(text, candidate))) return candidate;
  }
  return toward;
}

/** `color` moved toward `toward` until it reads on every surface; `toward` at worst. */
function readableOn(color: string, surfaces: readonly string[], toward: string): string {
  for (let step = 0; step <= 20; step += 1) {
    const candidate = storefrontThemeMix(color, toward, step / 20);
    if (surfaces.every((surface) => reads(candidate, surface))) return candidate;
  }
  return toward;
}

/** The grey as light as `color` (the same WCAG luminance, so the same contrast with everything). */
function greyLike(color: string): string {
  const luminance = storefrontThemeLuminance(color);
  const srgb = luminance <= 0.0031308 ? luminance * 12.92 : 1.055 * luminance ** (1 / 2.4) - 0.055;
  return channelsHex([srgb * 255, srgb * 255, srgb * 255]);
}

interface Swatch {
  hex: string;
  luminance: number;
  lab: readonly [number, number, number];
}

const swatch = (hex: string): Swatch => ({ hex, luminance: storefrontThemeLuminance(hex), lab: storefrontThemeLab(hex) });
const labDistance = (left: Swatch["lab"], right: Swatch["lab"]) => Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
const readsLuminance = (text: number, surface: number) => (Math.max(text, surface) + 0.05) / (Math.min(text, surface) + 0.05) >= STOREFRONT_THEME_MIN_CONTRAST;

let swatches: { greys: Swatch[]; edge: Swatch[] } | null = null;
/**
 * The colours the error-colour search tries, made on first use: every grey,
 * and the faces of the sRGB cube at 32 steps an edge. Readability depends on
 * lightness alone, and at any lightness the most colourful colours (the
 * furthest from a grey) lie on the cube's faces, so the faces hold the best
 * answer there is.
 */
function searchSwatches(): { greys: Swatch[]; edge: Swatch[] } {
  if (swatches) return swatches;
  const greys = Array.from({ length: 256 }, (_, level) => swatch(channelsHex([level, level, level])));
  const edge = new Map<string, Swatch>();
  const step = (index: number) => (index * 255) / 32;
  for (let axis = 0; axis < 3; axis += 1) {
    for (const fixed of [0, 255]) {
      for (let first = 0; first <= 32; first += 1) {
        for (let second = 0; second <= 32; second += 1) {
          const free = [step(first), step(second)];
          const channels = [0, 1, 2].map((channel) => (channel === axis ? fixed : free.shift()!));
          const hex = channelsHex(channels);
          if (!edge.has(hex)) edge.set(hex, swatch(hex));
        }
      }
    }
  }
  swatches = { greys, edge: [...edge.values()] };
  return swatches;
}

/**
 * Lighter text and an error colour that both read and stand apart, when the
 * page leaves little room: the error colour nearest `preferred` (a red where
 * one works), lighter text staying `muted` if it can, else the readable grey
 * nearest it (the ends of the readable bands are the furthest from any
 * error colour, so only they are tried). Null when no pair exists.
 */
function errorApartFromMuted(muted: string, preferred: string, mutedSurfaces: readonly string[], errorSurfaces: readonly string[]): { muted: string; error: string } | null {
  const { greys, edge } = searchSwatches();
  const lights = (surfaces: readonly string[]) => surfaces.map(storefrontThemeLuminance);
  const [mutedOn, errorOn] = [lights(mutedSurfaces), lights(errorSurfaces)];
  const readableGrey = greys.map((grey) => mutedOn.every((surface) => readsLuminance(grey.luminance, surface)));
  const ends = greys.filter((_, level) => readableGrey[level] && !(readableGrey[level - 1] && readableGrey[level + 1]));
  const current = swatch(muted);
  const candidates = [current, ...ends.sort((left, right) => Math.abs(left.lab[0] - current.lab[0]) - Math.abs(right.lab[0] - current.lab[0]))];
  const target = storefrontThemeLab(preferred);
  const errors = edge.filter((error) => errorOn.every((surface) => readsLuminance(error.luminance, surface)))
    .sort((left, right) => labDistance(left.lab, target) - labDistance(right.lab, target));
  for (const grey of candidates) {
    const error = errors.find((each) => labDistance(each.lab, grey.lab) >= STOREFRONT_THEME_MIN_MUTED_ERROR_DISTANCE);
    if (error) return { muted: grey.hex, error: error.hex };
  }
  return null;
}

/**
 * The colour set with every colour no field shows made from the six fields,
 * so any readable choice of the fields saves:
 * - Surfaces (cards, menus, shaded panels, light buttons, borders) keep their
 *   place between the page and the text, with their tint, as `reference` has
 *   them, then step back toward the page until the text, the buttons (on
 *   cards) and black or white read on them as they do on the page.
 * - Lighter text keeps its place between text and page, moving toward the
 *   text until it reads on the page, panels and cards; a tinted one turns
 *   to the grey as light as it.
 * - The error colour is the reference's, deepened or lightened until it reads
 *   on the page and cards and reddened until it stands apart from lighter
 *   text (on a mid-tone page, the nearest colour that does); text on it is
 *   black or white when its own does not read.
 * Lighter text is placed anew when the page or the text changed from
 * `previous`, surfaces when the page did or the text crossed to the page's
 * other side; otherwise every colour keeps its value while it reads (a
 * darker text leaves the cards as they are), and the field border is redrawn
 * only when the page, the text or the card it shows against changed.
 */
export function fitThemeColors(
  colors: Record<StorefrontThemeColorKey, string>,
  previous: Record<StorefrontThemeColorKey, string>,
  reference: Record<StorefrontThemeColorKey, string> = previous,
): Record<StorefrontThemeColorKey, string> {
  const next = { ...colors };
  const { background: page, foreground: text, primary } = next;
  const ink = storefrontThemeContrast("#000000", page) >= storefrontThemeContrast("#ffffff", page) ? "#000000" : "#ffffff";
  const lighter = (color: string, than: string) => storefrontThemeLuminance(color) > storefrontThemeLuminance(than);
  // A new text moves the surfaces only when it crosses to the page's other side (or the old pair was too alike to place them by).
  const textCrossed = text !== previous.foreground
    && (lighter(text, page) !== lighter(previous.foreground, previous.background) || storefrontThemeContrast(previous.foreground, previous.background) < PLACEABLE_CONTRAST);
  if (page !== previous.background || textCrossed) {
    for (const token of SURFACE_TOKENS) next[token] = onLine(placeOnLine(reference[token], reference.background, reference.foreground), page, text);
  }
  if (page !== previous.background || text !== previous.foreground) {
    next["muted-foreground"] = onLine(placeOnLine(reference["muted-foreground"], reference.foreground, reference.background), text, page);
    next.destructive = reference.destructive;
    next["destructive-foreground"] = reference["destructive-foreground"];
  }
  // Only text that reads on the page is held on the surfaces: an unreadable text colour is its field's problem.
  const onPage = (texts: readonly string[]) => texts.filter((each) => reads(each, page));
  next.card = untilRead(next.card, onPage([text, primary, ink]), page);
  next.popover = untilRead(next.popover, onPage([text, primary, ink]), page);
  next.muted = untilRead(next.muted, onPage([text, ink]), page);
  next.secondary = untilRead(next.secondary, onPage([text, ink]), page);
  if (page !== previous.background || text !== previous.foreground || next.card !== previous.card) next.input = storefrontThemeFieldBorder(next);
  const surfaces = [page, next.muted, next.card];
  let muted = readableOn(next["muted-foreground"], surfaces, text);
  if (storefrontThemeChroma(muted) > STOREFRONT_THEME_MAX_MUTED_CHROMA) muted = readableOn(greyLike(muted), surfaces, ink);
  const errorSurfaces = [page, next.card];
  const apart = (error: string) => storefrontThemeColorDistance(muted, error) >= STOREFRONT_THEME_MIN_MUTED_ERROR_DISTANCE;
  let error = readableOn(next.destructive, errorSurfaces, ink);
  for (let step = 1; step <= 10 && !apart(error); step += 1) error = readableOn(storefrontThemeMix(next.destructive, "#ff0000", step / 10), errorSurfaces, ink);
  if (!apart(error)) {
    const found = errorApartFromMuted(muted, next.destructive, surfaces, errorSurfaces);
    if (found) ({ muted, error } = found);
  }
  next["muted-foreground"] = muted;
  next.destructive = error;
  if (!reads(next["destructive-foreground"], error)) {
    next["destructive-foreground"] = storefrontThemeContrast("#000000", error) >= storefrontThemeContrast("#ffffff", error) ? "#000000" : "#ffffff";
  }
  return next;
}

/** Below this, a set's page and text are too alike to place its other colours between them. */
const PLACEABLE_CONTRAST = 2;

/**
 * The colours a set's hidden colours keep their places from: the set's own
 * (an app template's or an agent's palette keeps its tints), unless its page
 * and text are too alike to measure against; then the template's for the
 * colours, and the ones made from the colours for the dark colours.
 */
function colorReference(theme: StorefrontThemeDocument, set: StorefrontThemeColorSet, current: Record<StorefrontThemeColorKey, string>): Record<StorefrontThemeColorKey, string> {
  if (storefrontThemeContrast(current.foreground, current.background) >= PLACEABLE_CONTRAST) return current;
  return set === "colors" ? storefrontTemplateTheme(theme.template).tokens.colors : storefrontDarkPalette(theme.tokens.colors);
}

/** Every token a colour field writes. */
const FIELD_TOKENS = Object.values(COLOR_ROLES).flat();

/**
 * The colour set each set `setThemeColor` made was made from. Edits keep
 * making the hidden colours from it, not from the last edit's rounded and
 * readability-moved ones, so no colour drifts edit by edit, and typing the
 * fields' first values back gives the first set exactly. A set reached any
 * other way (opened, undone to, restored) is its own origin.
 */
const madeFrom = new WeakMap<object, Record<StorefrontThemeColorKey, string>>();

/**
 * The document with one role's colour (a complete #rrggbb: the fields commit
 * nothing else) set on every token of that role, in one colour set, and the
 * colours no field shows made from the fields (`fitThemeColors`). A colour
 * the role already has changes nothing.
 */
export function setThemeColor(theme: StorefrontThemeDocument, role: ColorRole, value: string, set: StorefrontThemeColorSet = "colors"): StorefrontThemeDocument {
  const current = theme.tokens[set];
  if (!current || COLOR_ROLES[role].every((token) => current[token] === value)) return theme;
  const origin = madeFrom.get(current) ?? current;
  const edited = { ...current };
  for (const token of COLOR_ROLES[role]) edited[token] = value;
  let colors = edited;
  if (allThemeColorsValid(edited) && allThemeColorsValid(origin) && allThemeColorsValid(theme.tokens.colors)) {
    // The fields as they now stand, over the origin's hidden colours.
    const fields = { ...origin };
    for (const token of FIELD_TOKENS) fields[token] = edited[token];
    colors = FIELD_TOKENS.every((token) => fields[token] === origin[token]) ? origin : fitThemeColors(fields, origin, colorReference(theme, set, origin));
    if (colors !== origin) madeFrom.set(colors, origin);
  }
  // Dark colours made from the colours follow a light colour edit; ones the merchant edited stay.
  const darkColors = set === "colors" && darkColorsFollowColors(theme) && allThemeColorsValid(colors)
    ? storefrontDarkPalette(colors)
    : theme.tokens.darkColors;
  return { ...theme, tokens: { ...theme.tokens, darkColors, [set]: colors } };
}

/** A single-variant block slot the Theme page offers as a picker. */
export type ThemeBlockSlot = Exclude<StorefrontBlockSlot, "listing">;

/** The variant a slot is set to in the document. */
export function blockVariant(theme: StorefrontThemeDocument, slot: ThemeBlockSlot): string {
  return slot === "gallery" || slot === "buyBox" ? theme.blocks.product[slot].variant : theme.blocks[slot].variant;
}

/**
 * The document with a block switched to another variant: the new variant's
 * defaults, keeping every setting both variants share (the announcement's
 * words and link, the footer's words).
 */
export function setBlockVariant(theme: StorefrontThemeDocument, slot: ThemeBlockSlot, variant: string): StorefrontThemeDocument {
  const block = storefrontBlockSwitch(slot, storefrontBlockValue(theme.blocks, slot), variant) as never;
  const blocks = slot === "gallery" || slot === "buyBox"
    ? { ...theme.blocks, product: { ...theme.blocks.product, [slot]: block } }
    : { ...theme.blocks, [slot]: block };
  return { ...theme, blocks };
}

/**
 * The document resolved against the store's shape: the same resolver and
 * the same facts the storefront renders with, so what the Theme page says
 * about a choice is what buyers see.
 */
export function resolveThemeForStore(theme: StorefrontThemeDocument, shape: StoreShape): ResolvedStorefrontTheme {
  return resolveStorefrontTheme(theme, shape);
}

/** Why a block renders another variant on this store, if it does. */
export function blockFallback(resolved: ResolvedStorefrontTheme, slot: ThemeBlockSlot): StorefrontThemeFallback | null {
  return resolved.fallbacks.find((fallback) => fallback.kind === "block" && fallback.key === slot) ?? null;
}

export type ContrastMessage =
  | "contrastText"
  | "contrastTextOnCards"
  | "contrastTextOnPanels"
  | "contrastSecondary"
  | "contrastButtonText"
  | "contrastLinks"
  | "contrastLinksOnCards"
  | "contrastMuted"
  | "contrastMutedOnCards"
  | "contrastMutedOnPanels"
  | "contrastAccent"
  | "contrastError"
  | "contrastErrorOnCards"
  | "contrastErrorText"
  | "errorApart";

/**
 * Each text pair the storefront must keep readable, in plain words naming
 * that pair's own text and surface, on the colour field that changes it: the
 * text's field where a field shows the text, else the field it is made
 * from (lighter text from Text, the error colour from Background). Header
 * pairs read as the tokens the header tone gives them. Pairs a role always
 * moves together (cards and menus) share one message.
 */
const CONTRAST_MESSAGES: Record<string, { message: ContrastMessage; role: ColorRole }> = {
  "foreground/background": { message: "contrastText", role: "text" },
  "background/foreground": { message: "contrastText", role: "text" },
  "card-foreground/card": { message: "contrastTextOnCards", role: "text" },
  "popover-foreground/popover": { message: "contrastTextOnCards", role: "text" },
  "foreground/muted": { message: "contrastTextOnPanels", role: "text" },
  "secondary-foreground/secondary": { message: "contrastSecondary", role: "text" },
  "primary-foreground/primary": { message: "contrastButtonText", role: "buttonText" },
  "primary/background": { message: "contrastLinks", role: "buttons" },
  "primary/card": { message: "contrastLinksOnCards", role: "buttons" },
  "muted-foreground/background": { message: "contrastMuted", role: "text" },
  "muted-foreground/card": { message: "contrastMutedOnCards", role: "text" },
  "muted-foreground/muted": { message: "contrastMutedOnPanels", role: "text" },
  "accent-foreground/accent": { message: "contrastAccent", role: "highlightText" },
  "destructive/background": { message: "contrastError", role: "background" },
  "destructive/card": { message: "contrastErrorOnCards", role: "background" },
  "destructive-foreground/destructive": { message: "contrastErrorText", role: "background" },
};

/** The pairs of two fields' own colours, each shown on its text's field: Text, Buttons and links, Button text, Text on highlights. */
const OWN_PAIR_MESSAGES: readonly ContrastMessage[] = ["contrastText", "contrastLinks", "contrastButtonText", "contrastAccent"];

export interface ContrastProblem {
  message: ContrastMessage;
  /** The colour set the problem is in. */
  set: StorefrontThemeColorSet;
  /** The colour field that shows the problem. */
  role: ColorRole;
  /** The worst ratio among the pairs behind this message. */
  ratio: number;
}

export function allThemeColorsValid(colors: Record<StorefrontThemeColorKey, string>): boolean {
  return STOREFRONT_THEME_COLOR_KEYS.every((key) => isStorefrontThemeHexColor(colors[key] ?? ""));
}

/**
 * AA problems of one colour set in plain words, one per message, over every
 * pair the chosen blocks paint (empty while any of its colours is not yet a
 * valid #rrggbb, and for dark colours buyers cannot see).
 */
export function themeContrastProblems(theme: StorefrontThemeDocument, set: StorefrontThemeColorSet = "colors"): ContrastProblem[] {
  const colors = theme.tokens[set];
  if (!colors || !themeColorSets(theme).includes(set) || !allThemeColorsValid(colors)) return [];
  const byMessage = new Map<ContrastMessage, ContrastProblem>();
  for (const { text, surface, ratio } of listStorefrontThemeDocumentContrastProblems(theme, set)) {
    const pair = `${storefrontContrastRoleToken(text, theme.tokens, set)}/${storefrontContrastRoleToken(surface, theme.tokens, set)}`;
    const { message, role } = CONTRAST_MESSAGES[pair] ?? { message: "contrastText", role: "text" };
    const known = byMessage.get(message);
    if (known) known.ratio = Math.min(known.ratio, ratio);
    else byMessage.set(message, { message, set, role, ratio });
  }
  // While a field's own pair fails, the colours made from it cannot read either: the field says its own problem once.
  const own = new Set([...byMessage.keys()].filter((message) => OWN_PAIR_MESSAGES.includes(message)).map((message) => byMessage.get(message)!.role));
  const problems = [...byMessage.values()].filter((problem) => !own.has(problem.role) || OWN_PAIR_MESSAGES.includes(problem.message));
  // Every pair reads, but error text looks like lighter text (the server refuses it too): on some pages no error colour both reads and stands apart.
  if (problems.length === 0 && storefrontThemeColorDistance(colors["muted-foreground"], colors.destructive) < STOREFRONT_THEME_MIN_MUTED_ERROR_DISTANCE) {
    problems.push({ message: "errorApart", set, role: "background", ratio: 0 });
  }
  return problems;
}

/**
 * The first field of one colour set to fix: a colour that is not #rrggbb,
 * then a pair below AA (`role` null: a colour no field shows, or the set is
 * missing). Null when the set is valid and readable, or buyers cannot see it.
 */
export function themeColorSetProblem(theme: StorefrontThemeDocument, set: StorefrontThemeColorSet): { role: ColorRole | null } | null {
  if (!themeColorSets(theme).includes(set)) return null;
  const colors = theme.tokens[set];
  if (!colors) return { role: null };
  const bad = (Object.keys(COLOR_ROLE_TOKEN) as ColorRole[]).find((role) => !isStorefrontThemeHexColor(colors[COLOR_ROLE_TOKEN[role]] ?? ""));
  if (bad || !allThemeColorsValid(colors)) return { role: bad ?? null };
  const problem = themeContrastProblems(theme, set)[0];
  return problem ? { role: problem.role } : null;
}

/** The first colour field to fix, in the colours and then the dark colours buyers can see; null when there is none. */
export function themeColorProblem(theme: StorefrontThemeDocument): { set: StorefrontThemeColorSet; role: ColorRole | null } | null {
  for (const set of themeColorSets(theme)) {
    const problem = themeColorSetProblem(theme, set);
    if (problem) return { set, ...problem };
  }
  return null;
}

/** Dark pages can show while the header logo has no dark version: it may not show on them. */
export function darkLogoMissing(theme: StorefrontThemeDocument): boolean {
  return themeColorSets(theme).includes("darkColors") && !storefrontThemeColorsAreDark(theme.tokens.colors)
    && theme.brand.logo !== null && theme.brand.darkLogo === null;
}

/**
 * The logo for dark pages is offered while the store can show dark pages,
 * and stays (to be removed) while one is set; a light-only store never sees it.
 */
export function darkLogoOffered(theme: StorefrontThemeDocument): boolean {
  return themeColorSets(theme).includes("darkColors") || theme.brand.darkLogo !== null;
}

/** A logo for dark pages is set, but the store shows no dark pages: it never shows. */
export function darkLogoUnused(theme: StorefrontThemeDocument): boolean {
  return theme.brand.darkLogo !== null && !themeColorSets(theme).includes("darkColors");
}

/**
 * What the logo for dark pages says under it: that it never shows (no dark
 * pages), that it is not needed (the light colours are dark themselves, so
 * the header logo already sits on a dark page, as `sameDarkPages` says of the
 * dark colours), or what it is for.
 */
export function darkLogoHelp(theme: StorefrontThemeDocument): "darkLogoUnused" | "darkLogoNotNeeded" | "darkLogoHelp" {
  if (darkLogoUnused(theme)) return "darkLogoUnused";
  return storefrontThemeColorsAreDark(theme.tokens.colors) ? "darkLogoNotNeeded" : "darkLogoHelp";
}

/** Dark pages show, but their colours are the colours (dark themselves): the scheme and the switch change nothing. */
export function sameDarkPages(theme: StorefrontThemeDocument): boolean {
  const { colors, darkColors } = theme.tokens;
  return themeColorSets(theme).includes("darkColors") && darkColors !== null && storefrontThemeColorsAreDark(colors)
    && STOREFRONT_THEME_COLOR_KEYS.every((key) => colors[key] === darkColors[key]);
}

/** Whether the dark colours differ from the ones made from the colours (the merchant edited them). */
export function darkColorsEdited(theme: StorefrontThemeDocument): boolean {
  return theme.tokens.darkColors !== null && !darkColorsFollowColors(theme);
}

/** The document with its dark colours made again from its colours. */
export function regenerateDarkColors(theme: StorefrontThemeDocument): StorefrontThemeDocument {
  return { ...theme, tokens: { ...theme.tokens, darkColors: storefrontDarkPalette(theme.tokens.colors) } };
}

/**
 * Applying a look replaced dark colours the merchant edited (they were
 * unreadable with it, so they were made again from its colours): the
 * merchant is told before choosing it.
 */
export function editedDarkColorsReplaced(current: StorefrontThemeDocument, applied: StorefrontThemeDocument): boolean {
  const dark = applied.tokens.darkColors;
  return darkColorsEdited(current) && themeColorSets(applied).includes("darkColors") && dark !== null
    && !sameFormValue(dark, current.tokens.darkColors) && storefrontDarkColorsAreMade(applied.tokens.colors, dark);
}

/** The announcement link as typed: null (none) or canonical, else not usable yet. */
export function announcementLinkInvalid(theme: StorefrontThemeDocument): boolean {
  const link = "link" in theme.blocks.topBar.settings ? theme.blocks.topBar.settings.link : null;
  return link !== null && canonicalStorefrontLink(link) !== link;
}

/** A one-product homepage without its product. */
export function homeProductMissing(theme: StorefrontThemeDocument): boolean {
  return theme.pages.homeMode.kind === "product" && !theme.pages.homeMode.productId;
}

/**
 * True while the document cannot be saved: a colour that is not #rrggbb, text
 * below AA, an announcement link that is not a usable link, or a one-product
 * homepage without its product. Each field says why.
 */
export function themeDraftInvalid(theme: StorefrontThemeDocument): boolean {
  return themeColorProblem(theme) !== null
    || announcementLinkInvalid(theme)
    || homeProductMissing(theme);
}

/** DOM ids of the theme's own fields (brand images, the homepage's product). */
export const THEME_FIELD_IDS = {
  logo: "theme-brand-logo",
  logoWidth: "theme-logo-width",
  darkLogo: "theme-brand-dark-logo",
  footerLogo: "theme-brand-footer-logo",
  favicon: "theme-brand-favicon",
  homeProduct: "theme-home-product",
} as const;

function sameLook(left: StorefrontThemeDocument, right: StorefrontThemeDocument): boolean {
  return sameFormValue(left.tokens, right.tokens) && sameFormValue(left.blocks, right.blocks) && sameFormValue(left.pages, right.pages);
}

/** A template an app offers: its key (`<app id>/<template id>`), name, app and look. */
export interface AppTemplateEntry {
  key: string;
  name: string;
  description: string | null;
  app: ThemeApp;
  theme: StorefrontAppTemplateTheme;
  /** Card fields the template names that this store cannot show: left out of `theme`. */
  omittedCardFields: readonly string[];
}

/** The active apps' templates, as the API lists them at this document version (one that does not parse is left out). */
export function appTemplates(apps: readonly ThemeApp[]): AppTemplateEntry[] {
  return apps.flatMap((app) => app.templates.flatMap((template) => {
    const theme = readStorefrontAppTemplateTheme(template.theme, STOREFRONT_THEME_DOCUMENT_VERSION);
    return theme ? [{ key: template.key, name: template.name, description: template.description, app, theme, omittedCardFields: template.omittedCardFields }] : [];
  }));
}

/** An app template applied to the document (`applyStorefrontAppTemplate`): its look, skins and homepage sections. */
export function applyAppTemplate(template: AppTemplateEntry, current: StorefrontThemeDocument): StorefrontThemeDocument {
  return applyStorefrontAppTemplate(current, template.key, template.theme);
}

/** Each template's complete document, for previews and matching. */
export const TEMPLATE_THEMES: ReadonlyArray<{ id: StorefrontTemplateId; theme: StorefrontThemeDocument }> =
  STOREFRONT_TEMPLATES.map(({ id }) => ({ id, theme: storefrontTemplateTheme(id) }));

const TEMPLATE_LOOKS = TEMPLATE_THEMES.map(({ id, theme }) => ({ id, look: storefrontThemeLook(theme) }));

/** The template whose every choice the theme still matches, if any (its content aside). */
export function selectedTemplate(theme: StorefrontThemeDocument): StorefrontTemplateId | null {
  const look = storefrontThemeLook(theme);
  return TEMPLATE_LOOKS.find((template) => sameLook(template.look, look))?.id ?? null;
}

/**
 * A template's look (blocks, tokens, colours and homepage sections) with the
 * current document's content kept: logo, announcement and footer words, hero
 * slides, chosen categories and collections, and what `/` shows.
 */
export function applyTemplate(id: StorefrontTemplateId, current: StorefrontThemeDocument | null): StorefrontThemeDocument {
  return storefrontThemeWithContent(storefrontTemplateTheme(id), current);
}

// ─── Typography ───────────────────────────────────────────────────────────

/** The type tokens the Typography card sets together. */
export const TYPE_TOKEN_KEYS = ["typography", "typeScale", "headingCase"] as const;
export type TypeTokenKey = (typeof TYPE_TOKEN_KEYS)[number];
export type TypeTokens = Pick<StorefrontThemeTokens, TypeTokenKey>;

/** The type tokens of the template the theme is based on. */
export function templateTypeTokens(theme: StorefrontThemeDocument): TypeTokens {
  const { tokens } = storefrontTemplateTheme(theme.template);
  return { typography: tokens.typography, typeScale: tokens.typeScale, headingCase: tokens.headingCase };
}

/** True while the theme's type tokens are its template's. */
export function typeTokensAreTemplateDefault(theme: StorefrontThemeDocument): boolean {
  const defaults = templateTypeTokens(theme);
  return TYPE_TOKEN_KEYS.every((key) => theme.tokens[key] === defaults[key]);
}

/** The document with some type tokens set. */
export function setTypeTokens(theme: StorefrontThemeDocument, next: Partial<TypeTokens>): StorefrontThemeDocument {
  return { ...theme, tokens: { ...theme.tokens, ...next } };
}

/** The document with its template's type tokens back. */
export function resetTypeTokens(theme: StorefrontThemeDocument): StorefrontThemeDocument {
  return setTypeTokens(theme, templateTypeTokens(theme));
}

/**
 * The name a storefront family is registered under in the dashboard, so the
 * previews never replace the dashboard's own Inter or Noto Sans Bengali.
 */
export function previewFamily(family: string): string {
  return `Preview ${family}`;
}

export interface TypePairingPreview {
  heading: { family: string; stack: string; weight: number };
  body: { family: string; stack: string };
  /** The Bengali family Bangla text falls through to. */
  bangla: string;
}

/**
 * What a pairing draws with, as the storefront's token CSS stacks it (Latin
 * face, then the pairing's Bengali face, then the fallbacks), under the
 * preview names. Until the picker registers the faces, the stacks fall back
 * to the fallbacks without downloading anything.
 */
export function typePairingPreview(pairing: StorefrontTypePairing): TypePairingPreview {
  const spec = STOREFRONT_TYPE_PAIRING_SPECS[pairing];
  const bangla = STOREFRONT_BANGLA_FONTS[spec.bangla];
  const stack = (font: keyof typeof STOREFRONT_FONTS) =>
    `"${previewFamily(STOREFRONT_FONTS[font].family)}", "${previewFamily(bangla.family)}", "${STOREFRONT_BENGALI_SYSTEM_FONT}", ${STOREFRONT_FONTS[font].fallback}, ${bangla.fallback}`;
  return {
    heading: { family: STOREFRONT_FONTS[spec.heading].family, stack: stack(spec.heading), weight: spec.headingWeight },
    body: { family: STOREFRONT_FONTS[spec.body].family, stack: stack(spec.body) },
    bangla: bangla.family,
  };
}

/** The first free id among `taken`: the base, then base-2, base-3… */
export function nextFreeId(base: string, taken: Iterable<{ id: string }>): string {
  const used = new Set([...taken].map((each) => each.id));
  if (!used.has(base)) return base;
  for (let number = 2; ; number += 1) {
    if (!used.has(`${base}-${number}`)) return `${base}-${number}`;
  }
}

// ─── Product page app blocks ──────────────────────────────────────────────

/** An app's product-page block as the workspace offers it, with its app. */
export interface AppBlockEntry {
  app: ThemeApp;
  block: ThemeAppBlock;
}

/** The active apps' product-page blocks by key (`<plugin id>/<type>`). */
export function appBlocksByKey(apps: readonly ThemeApp[]): ReadonlyMap<string, AppBlockEntry> {
  return new Map(apps.flatMap((app) => app.components.flatMap((component) => {
    const placement = storefrontComponentProductSlot(component.targets);
    return placement ? [[component.key, { app, block: { ...component, placement } }] as const] : [];
  })));
}

/** The product page's app blocks in the merchant's order (none when the theme names none). */
export function productAppBlocks(theme: StorefrontThemeDocument): StorefrontProductAppBlock[] {
  return theme.blocks.product.apps ?? [];
}

function withProductAppBlocks(theme: StorefrontThemeDocument, blocks: StorefrontProductAppBlock[]): StorefrontThemeDocument {
  const { apps: _apps, ...rest } = theme.blocks.product;
  // No blocks is the theme without the list, as before any was added.
  return { ...theme, blocks: { ...theme.blocks, product: blocks.length > 0 ? { ...rest, apps: blocks } : rest } };
}

/** The theme with a new app block last (the app's starting values), or null at the limit. */
export function addProductAppBlock(
  theme: StorefrontThemeDocument,
  app: string,
  values: AppSettingValues,
): { theme: StorefrontThemeDocument; id: string } | null {
  const blocks = productAppBlocks(theme);
  if (blocks.length >= PLUGIN_PRODUCT_BLOCKS_MAX) return null;
  const id = nextFreeId("app", blocks);
  return { theme: withProductAppBlocks(theme, [...blocks, { id, app, values: { ...values } }]), id };
}

export function removeProductAppBlock(theme: StorefrontThemeDocument, id: string): StorefrontThemeDocument {
  return withProductAppBlocks(theme, productAppBlocks(theme).filter((block) => block.id !== id));
}

/** The theme with one app block moved one place up (-1) or down (1). */
export function moveProductAppBlock(theme: StorefrontThemeDocument, id: string, delta: -1 | 1): StorefrontThemeDocument {
  const blocks = [...productAppBlocks(theme)];
  const from = blocks.findIndex((block) => block.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= blocks.length) return theme;
  [blocks[from], blocks[to]] = [blocks[to]!, blocks[from]!];
  return withProductAppBlocks(theme, blocks);
}

export function setProductAppBlockValues(theme: StorefrontThemeDocument, id: string, values: AppSettingValues): StorefrontThemeDocument {
  return withProductAppBlocks(theme, productAppBlocks(theme).map((block) => (block.id === id ? { ...block, values } : block)));
}

export function setProductAppBlockBindings(theme: StorefrontThemeDocument, id: string, bindings: SettingBindings | undefined): StorefrontThemeDocument {
  return withProductAppBlocks(theme, productAppBlocks(theme).map((block) => (block.id === id ? { ...block, bindings } : block)));
}

/** True while an app block's values break what its app declares (blocks of inactive apps are not judged). */
export function productAppBlocksInvalid(theme: StorefrontThemeDocument, byKey: ReadonlyMap<string, AppBlockEntry>): boolean {
  return productAppBlocks(theme).some((block) => {
    const entry = byKey.get(block.app);
    return entry !== undefined && appValuesInvalid(entry.block.settings, block.values);
  });
}

/** The field ids of an app block's settings start with this (`theme-product-app-app-2`). */
export const productAppBlockFieldPrefix = (id: string) => `theme-product-app-${id}`;

const PRODUCT_MODULE_ORDER = Object.keys(STOREFRONT_PRODUCT_MODULES) as StorefrontProductModule[];

/** The module list with `module` on or off; a module turned on joins at its registry place among the others. */
export function toggleProductModule(
  below: readonly StorefrontProductModule[],
  module: StorefrontProductModule,
  on: boolean,
): StorefrontProductModule[] {
  const rest = below.filter((each) => each !== module);
  if (!on) return rest;
  const rank = PRODUCT_MODULE_ORDER.indexOf(module);
  const at = rest.findIndex((each) => PRODUCT_MODULE_ORDER.indexOf(each) > rank);
  return at < 0 ? [...rest, module] : [...rest.slice(0, at), module, ...rest.slice(at)];
}

// ─── App skins of the theme's units ───────────────────────────────────────

/** The units an app skin can draw (a core section's skin sits on its placement). */
export type AppSkinUnit = StorefrontThemeSkinUnit;
export const APP_SKIN_UNITS = STOREFRONT_SKIN_UNITS satisfies readonly AppSkinUnit[];

/** An app's skin as the workspace offers it, with its app. */
export interface AppSkinEntry {
  app: ThemeApp;
  skin: ThemeAppSkin;
}

/** The active apps' skins by key (`<plugin id>/<skin id>`). */
export function appSkinsByKey(apps: readonly ThemeApp[]): ReadonlyMap<string, AppSkinEntry> {
  return new Map(apps.flatMap((app) => app.skins.map((skin) => [skin.key, { app, skin }] as const)));
}

/** The app skin drawing a unit in the theme, or null for the built-in one. */
export function themeAppSkin(theme: StorefrontThemeDocument, unit: AppSkinUnit): StorefrontSkinRef | null {
  return theme.apps?.skins?.[unit] ?? null;
}

/**
 * The theme with an app skin drawing a unit, or the built-in one back
 * (null). A theme whose skins draw nothing and name no template has no
 * `apps`, as before any app drew one.
 */
export function setThemeAppSkin(theme: StorefrontThemeDocument, unit: AppSkinUnit, value: StorefrontSkinRef | null): StorefrontThemeDocument {
  const { [unit]: _previous, ...others } = theme.apps?.skins ?? {};
  const skins = value ? { ...others, [unit]: value } : others;
  const { skins: _skins, ...rest } = theme.apps ?? {};
  const apps = Object.keys(skins).length > 0 ? { ...rest, skins } : rest;
  const { apps: _apps, ...document } = theme;
  return Object.keys(apps).length > 0 ? { ...document, apps } : document;
}

/** The units whose skin values break what their app declares (skins of inactive apps are not judged). */
export function invalidAppSkins(theme: StorefrontThemeDocument, byKey: ReadonlyMap<string, AppSkinEntry>): AppSkinUnit[] {
  return APP_SKIN_UNITS.filter((unit) => {
    const chosen = themeAppSkin(theme, unit);
    const entry = chosen ? byKey.get(chosen.app) : undefined;
    return entry !== undefined && entry.skin.target === unit && appValuesInvalid(entry.skin.settings, chosen!.values);
  });
}

/** The field ids of a skin's app settings start with this (`theme-app-skin-header`). */
export const appSkinFieldPrefix = (unit: AppSkinUnit) => `theme-app-skin-${unit}`;

/**
 * A core section with an app's skin drawing it, or its own design back
 * (null: no `skin` key, as before any app drew it). An app section has no skin.
 */
export function withSectionSkin<S extends StorefrontSection>(section: S, update: (current: StorefrontSkinRef | null) => StorefrontSkinRef | null): S {
  if (section.type === "app") return section;
  const { skin, ...rest } = section as S & { skin?: StorefrontSkinRef };
  const next = update(skin ?? null);
  return (next ? { ...rest, skin: next } : rest) as S;
}

/** Whether a core section's skin values break what its app declares (a skin of an inactive app is not judged). */
export function sectionSkinInvalid(section: StorefrontSection, byKey: ReadonlyMap<string, AppSkinEntry>): boolean {
  const skin = section.type === "app" ? undefined : (section as { skin?: StorefrontSkinRef }).skin;
  const entry = skin ? byKey.get(skin.app) : undefined;
  return entry !== undefined && entry.skin.target === `section:${section.type}` && appValuesInvalid(entry.skin.settings, skin!.values);
}
