import {
  STOREFRONT_SECTION_REGISTRY,
  STOREFRONT_STYLE_PRESETS,
  STOREFRONT_THEME_COLOR_KEYS,
  isStorefrontThemeHexColor,
  listStorefrontThemeContrastProblems,
  storefrontStylePresetTheme,
  type StorefrontSection,
  type StorefrontStylePresetKey,
  type StorefrontThemeColorKey,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";

/**
 * The four colours a merchant picks; each writes every token that shares its
 * role. Background also moves the card and popover surfaces, keeping the
 * Style's own card-to-page relationship (see setThemeColor).
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
 * The card surface for a new page background: the Style the theme started
 * from keeps its card a set step lighter or darker than its page (retail's
 * white cards on warm paper, midnight's raised panels), so a new background
 * moves the card by the same step instead of flattening it.
 */
export function cardForBackground(theme: StorefrontThemeDocument, background: string): string {
  const style = storefrontStylePresetTheme(closestStylePreset(theme)).tokens.colors;
  if (!isStorefrontThemeHexColor(background)) return background;
  const [page, card] = [hexChannels(style.background), hexChannels(style.card)];
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

/** A section the Theme page owns (hero, collections…); anything else belongs to the builder. */
export function isThemeSection(section: { type: string }): boolean {
  const entry = (STOREFRONT_SECTION_REGISTRY as Record<string, { editor: string } | undefined>)[section.type];
  return entry?.editor === "theme";
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
 * together (text on cards, on popovers) share one message, so the merchant
 * reads each problem once.
 */
const CONTRAST_MESSAGES: Record<string, { message: ContrastMessage; role: ColorRole }> = {
  "foreground/background": { message: "contrastText", role: "text" },
  "card-foreground/card": { message: "contrastText", role: "text" },
  "popover-foreground/popover": { message: "contrastText", role: "text" },
  "primary-foreground/primary": { message: "contrastButtonText", role: "buttonText" },
  "primary/background": { message: "contrastLinks", role: "buttons" },
  "muted-foreground/background": { message: "contrastMuted", role: "background" },
  "muted-foreground/muted": { message: "contrastMuted", role: "background" },
  "muted-foreground/card": { message: "contrastMuted", role: "background" },
  "secondary-foreground/secondary": { message: "contrastSecondary", role: "background" },
  "accent-foreground/accent": { message: "contrastAccent", role: "background" },
  "destructive-foreground/destructive": { message: "contrastError", role: "background" },
  "destructive/background": { message: "contrastError", role: "background" },
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

/** AA problems in plain words, one per message (empty while any colour is not yet a valid #rrggbb). */
export function themeContrastProblems(colors: Record<StorefrontThemeColorKey, string>): ContrastProblem[] {
  if (!allThemeColorsValid(colors)) return [];
  const byMessage = new Map<ContrastMessage, ContrastProblem>();
  for (const { text, surface, ratio } of listStorefrontThemeContrastProblems(colors)) {
    const { message, role } = CONTRAST_MESSAGES[`${text}/${surface}`] ?? { message: "contrastText", role: "text" };
    const known = byMessage.get(message);
    if (known) known.ratio = Math.min(known.ratio, ratio);
    else byMessage.set(message, { message, role, ratio });
  }
  return [...byMessage.values()];
}

/** True while the document cannot be saved: a colour that is not #rrggbb, or text below AA. */
export function themeDraftInvalid(theme: StorefrontThemeDocument): boolean {
  const { colors } = theme.tokens;
  return !allThemeColorsValid(colors) || themeContrastProblems(colors).length > 0;
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

const themeSectionOrder = (theme: StorefrontThemeDocument) =>
  theme.sections.filter(isThemeSection).map((section) => section.type);

/** Same look: tokens, layout and homepage order match, whatever order the saved document lists its keys in. */
export function sameThemeLook(left: StorefrontThemeDocument, right: StorefrontThemeDocument): boolean {
  return same(left.tokens, right.tokens)
    && same(left.layout, right.layout)
    && same(themeSectionOrder(left), themeSectionOrder(right));
}

/** Each Style's complete document, for previews and matching. */
export const STYLE_PRESET_THEMES: ReadonlyArray<{ key: StorefrontStylePresetKey; theme: StorefrontThemeDocument }> =
  STOREFRONT_STYLE_PRESETS.map(({ key }) => ({ key, theme: storefrontStylePresetTheme(key) }));

/** The Style whose every choice the theme still matches, if any. */
export function selectedStylePreset(theme: StorefrontThemeDocument): StorefrontStylePresetKey | null {
  return STYLE_PRESET_THEMES.find((preset) => sameThemeLook(preset.theme, theme))?.key ?? null;
}

/**
 * The Style a fine-tuned theme started from: the one sharing the most
 * choices (fonts, corners, button shape, colours, layout including the
 * menus, and section order). Ties go to the earlier Style, so the answer is
 * stable.
 */
export function closestStylePreset(theme: StorefrontThemeDocument): StorefrontStylePresetKey {
  let best = STYLE_PRESET_THEMES[0]!;
  let bestScore = -1;
  for (const preset of STYLE_PRESET_THEMES) {
    const { tokens, layout } = preset.theme;
    const colors = Object.keys(tokens.colors) as Array<keyof typeof tokens.colors>;
    const matchingColors = colors.filter((key) => tokens.colors[key] === theme.tokens.colors[key]).length;
    const score = [
      same(tokens.typography, theme.tokens.typography),
      tokens.radius === theme.tokens.radius,
      tokens.buttonShape === theme.tokens.buttonShape,
      tokens.containerWidth === theme.tokens.containerWidth,
      same(tokens.components, theme.tokens.components),
      ...(Object.keys(layout) as Array<keyof typeof layout>).map((key) => layout[key] === theme.layout[key]),
      same(themeSectionOrder(preset.theme), themeSectionOrder(theme)),
    ].filter(Boolean).length + (4 * matchingColors) / colors.length;
    if (score > bestScore) {
      best = preset;
      bestScore = score;
    }
  }
  return best.key;
}

/**
 * The Style's complete document. Builder sections are not the Theme page's
 * to drop, so they keep their places and the Style's own sections fill the
 * rest in the Style's order.
 */
export function applyStylePreset(theme: StorefrontThemeDocument, key: StorefrontStylePresetKey): StorefrontThemeDocument {
  const preset = storefrontStylePresetTheme(key);
  if (theme.sections.every(isThemeSection)) return preset;
  const queue = [...preset.sections];
  const sections: StorefrontSection[] = theme.sections.map((section) =>
    isThemeSection(section) ? queue.shift() ?? section : section);
  return { ...preset, sections: [...sections, ...queue] };
}
