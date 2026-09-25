import {
  STOREFRONT_BANGLA_FONTS,
  STOREFRONT_FONTS,
  STOREFRONT_TEMPLATES,
  STOREFRONT_THEME_COLOR_KEYS,
  STOREFRONT_TYPE_PAIRING_SPECS,
  isStorefrontThemeHexColor,
  listStorefrontThemeDocumentContrastProblems,
  resolveStorefrontTheme,
  storefrontBlockDefault,
  storefrontTemplateTheme,
  type ResolvedStorefrontTheme,
  type StoreShape,
  type StorefrontBlockSlot,
  type StorefrontTemplateId,
  type StorefrontThemeColorKey,
  type StorefrontThemeDocument,
  type StorefrontThemeFallback,
  type StorefrontThemeTokens,
  type StorefrontTypePairing,
} from "@scalius/shared/storefront-theme";

/**
 * The four colours a merchant picks; each writes every token that shares its
 * role. Background also moves the card and popover surfaces, keeping the
 * template's own card-to-page relationship (see setThemeColor).
 */
export const COLOR_ROLES = {
  background: ["background", "card", "popover"],
  text: ["foreground", "card-foreground", "popover-foreground"],
  buttons: ["primary", "ring"],
  buttonText: ["primary-foreground"],
} as const satisfies Record<string, readonly StorefrontThemeColorKey[]>;

export type ColorRole = keyof typeof COLOR_ROLES;

/** The token each colour field shows. */
export const COLOR_ROLE_TOKEN: Record<ColorRole, StorefrontThemeColorKey> = {
  background: "background",
  text: "foreground",
  buttons: "primary",
  buttonText: "primary-foreground",
};

/** DOM id of each colour field, so save errors and contrast problems mark it. */
export const COLOR_FIELD_IDS: Record<ColorRole, string> = {
  background: "theme-color-background",
  text: "theme-color-text",
  buttons: "theme-color-buttons",
  buttonText: "theme-color-button-text",
};

function hexChannels(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function channelsHex(channels: readonly number[]): string {
  return `#${channels.map((channel) => Math.min(255, Math.max(0, Math.round(channel))).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The card surface for a new page background: the template the theme is
 * based on keeps its card a set step lighter or darker than its page
 * (retail's white cards on warm paper, midnight's raised panels), so a new
 * background moves the card by the same step instead of flattening it.
 */
export function cardForBackground(theme: StorefrontThemeDocument, background: string): string {
  const palette = storefrontTemplateTheme(theme.template).tokens.colors;
  if (!isStorefrontThemeHexColor(background)) return background;
  const [page, card] = [hexChannels(palette.background), hexChannels(palette.card)];
  const next = hexChannels(background);
  return channelsHex(next.map((channel, index) => channel + (card[index]! - page[index]!)));
}

/** The document with one role's colour set on every token of that role. */
export function setThemeColor(theme: StorefrontThemeDocument, role: ColorRole, value: string): StorefrontThemeDocument {
  const colors = { ...theme.tokens.colors };
  if (role === "background") {
    const card = cardForBackground(theme, value);
    colors.background = value;
    colors.card = card;
    colors.popover = card;
  } else {
    for (const token of COLOR_ROLES[role]) colors[token] = value;
  }
  return { ...theme, tokens: { ...theme.tokens, colors } };
}

/**
 * The colour field an API issue on `theme.tokens.colors.<token>` belongs to.
 * Tokens no field sets (muted text, error red) are read on the background, so
 * the background field is the one that can fix them.
 */
export function colorFieldForPath(path: string): string | undefined {
  const token = /(?:^|\.)colors\.([a-z-]+)$/.exec(path)?.[1];
  if (!token) return undefined;
  const role = (Object.keys(COLOR_ROLES) as ColorRole[]).find((key) =>
    (COLOR_ROLES[key] as readonly string[]).includes(token));
  return COLOR_FIELD_IDS[role ?? "background"];
}

/** The sections with the one whose id is `id` moved one place up (-1) or down (+1); unchanged at either end. */
export function moveSection<Section extends { id: string }>(
  sections: readonly Section[],
  id: string,
  delta: -1 | 1,
): Section[] {
  const next = [...sections];
  const from = next.findIndex((section) => section.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= next.length) return next;
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}

/** A single-variant block slot the Theme page offers as a picker. */
export type ThemeBlockSlot = Exclude<StorefrontBlockSlot, "listing" | "buyBox">;

/** The variant a slot is set to in the document. */
export function blockVariant(theme: StorefrontThemeDocument, slot: ThemeBlockSlot): string {
  return slot === "gallery" ? theme.blocks.product.gallery.variant : theme.blocks[slot].variant;
}

/** The document with a block switched to another variant (at that variant's default settings). */
export function setBlockVariant(theme: StorefrontThemeDocument, slot: ThemeBlockSlot, variant: string): StorefrontThemeDocument {
  const block = storefrontBlockDefault(slot, variant) as never;
  const blocks = slot === "gallery"
    ? { ...theme.blocks, product: { ...theme.blocks.product, gallery: block } }
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
  | "contrastButtonText"
  | "contrastLinks"
  | "contrastMuted"
  | "contrastSecondary"
  | "contrastAccent"
  | "contrastError";

/**
 * Plain-words names for the text pairs the storefront must keep readable,
 * and the colour field that can fix each. Pairs the colour roles always move
 * together (text on cards, on popovers, on the header) share one message, so
 * the merchant reads each problem once.
 */
const CONTRAST_MESSAGES: Record<string, { message: ContrastMessage; role: ColorRole }> = {
  "foreground/background": { message: "contrastText", role: "text" },
  "card-foreground/card": { message: "contrastText", role: "text" },
  "popover-foreground/popover": { message: "contrastText", role: "text" },
  "header-foreground/header-background": { message: "contrastText", role: "text" },
  "foreground/muted": { message: "contrastText", role: "text" },
  "primary-foreground/primary": { message: "contrastButtonText", role: "buttonText" },
  "primary/background": { message: "contrastLinks", role: "buttons" },
  "primary/card": { message: "contrastLinks", role: "buttons" },
  "muted-foreground/background": { message: "contrastMuted", role: "background" },
  "muted-foreground/muted": { message: "contrastMuted", role: "background" },
  "muted-foreground/card": { message: "contrastMuted", role: "background" },
  "secondary-foreground/secondary": { message: "contrastSecondary", role: "background" },
  "accent-foreground/accent": { message: "contrastAccent", role: "background" },
  "destructive-foreground/destructive": { message: "contrastError", role: "background" },
  "destructive/background": { message: "contrastError", role: "background" },
  "destructive/card": { message: "contrastError", role: "background" },
};

export interface ContrastProblem {
  message: ContrastMessage;
  /** The colour field that shows the problem. */
  role: ColorRole;
  /** The worst ratio among the pairs behind this message. */
  ratio: number;
}

export function allThemeColorsValid(colors: Record<StorefrontThemeColorKey, string>): boolean {
  return STOREFRONT_THEME_COLOR_KEYS.every((key) => isStorefrontThemeHexColor(colors[key] ?? ""));
}

/**
 * AA problems in plain words, one per message, over every pair the chosen
 * blocks paint (empty while any colour is not yet a valid #rrggbb).
 */
export function themeContrastProblems(theme: StorefrontThemeDocument): ContrastProblem[] {
  if (!allThemeColorsValid(theme.tokens.colors)) return [];
  const byMessage = new Map<ContrastMessage, ContrastProblem>();
  for (const { text, surface, ratio } of listStorefrontThemeDocumentContrastProblems(theme)) {
    const { message, role } = CONTRAST_MESSAGES[`${text}/${surface}`] ?? { message: "contrastText", role: "text" };
    const known = byMessage.get(message);
    if (known) known.ratio = Math.min(known.ratio, ratio);
    else byMessage.set(message, { message, role, ratio });
  }
  return [...byMessage.values()];
}

/** True while the document cannot be saved: a colour that is not #rrggbb, or text below AA. */
export function themeDraftInvalid(theme: StorefrontThemeDocument): boolean {
  return !allThemeColorsValid(theme.tokens.colors) || themeContrastProblems(theme).length > 0;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/** Same look: tokens, blocks and pages match, whatever order the saved document lists its keys in. */
export function sameThemeLook(left: StorefrontThemeDocument, right: StorefrontThemeDocument): boolean {
  return same(left.tokens, right.tokens) && same(left.blocks, right.blocks) && same(left.pages, right.pages);
}

/** Each template's complete document, for previews and matching. */
export const TEMPLATE_THEMES: ReadonlyArray<{ id: StorefrontTemplateId; theme: StorefrontThemeDocument }> =
  STOREFRONT_TEMPLATES.map(({ id }) => ({ id, theme: storefrontTemplateTheme(id) }));

/** The template whose every choice the theme still matches, if any. */
export function selectedTemplate(theme: StorefrontThemeDocument): StorefrontTemplateId | null {
  return TEMPLATE_THEMES.find((template) => sameThemeLook(template.theme, theme))?.id ?? null;
}

/** A template's complete document: blocks, tokens, colours and homepage sections. */
export function applyTemplate(id: StorefrontTemplateId): StorefrontThemeDocument {
  return storefrontTemplateTheme(id);
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
    `"${previewFamily(STOREFRONT_FONTS[font].family)}", "${previewFamily(bangla.family)}", ${STOREFRONT_FONTS[font].fallback}, ${bangla.fallback}`;
  return {
    heading: { family: STOREFRONT_FONTS[spec.heading].family, stack: stack(spec.heading), weight: spec.headingWeight },
    body: { family: STOREFRONT_FONTS[spec.body].family, stack: stack(spec.body) },
    bangla: bangla.family,
  };
}
