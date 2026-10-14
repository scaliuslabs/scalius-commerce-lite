import {
  STOREFRONT_BANGLA_FONTS,
  STOREFRONT_BENGALI_SYSTEM_FONT,
  STOREFRONT_FONTS,
  STOREFRONT_PRODUCT_MODULES,
  STOREFRONT_TEMPLATES,
  STOREFRONT_THEME_COLOR_KEYS,
  STOREFRONT_TYPE_PAIRING_SPECS,
  applyStorefrontAppTemplate,
  isStorefrontThemeHexColor,
  listStorefrontThemeDocumentContrastProblems,
  canonicalStorefrontLink,
  readStorefrontAppTemplateTheme,
  resolveStorefrontTheme,
  storefrontBlockSwitch,
  storefrontBlockValue,
  storefrontTemplateTheme,
  storefrontThemeLook,
  storefrontThemeWithContent,
  type ResolvedStorefrontTheme,
  type StoreShape,
  type StorefrontAppTemplateTheme,
  type StorefrontBlockSlot,
  type StorefrontProductAppBlock,
  type StorefrontProductModule,
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
import { STOREFRONT_SKIN_UNITS } from "@scalius/shared/plugins/storefront-protocol";
import type { ThemeApp, ThemeAppBlock, ThemeAppSkin } from "~/lib/api-query-options/online-store";
import { appValuesInvalid, type AppSettingValues } from "./schema-form/app-settings";

/**
 * The colours a merchant picks; each writes every token that shares its
 * role. Background also moves the card and popover surfaces, keeping the
 * template's own card-to-page relationship (see setThemeColor).
 */
export const COLOR_ROLES = {
  background: ["background", "card", "popover"],
  text: ["foreground", "card-foreground", "popover-foreground"],
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
  "accent-foreground/accent": { message: "contrastAccent", role: "highlightText" },
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
  return !allThemeColorsValid(theme.tokens.colors)
    || themeContrastProblems(theme).length > 0
    || announcementLinkInvalid(theme)
    || homeProductMissing(theme);
}

/** DOM ids of the theme's own fields (brand images, the homepage's product). */
export const THEME_FIELD_IDS = {
  logo: "theme-brand-logo",
  logoWidth: "theme-logo-width",
  footerLogo: "theme-brand-footer-logo",
  favicon: "theme-brand-favicon",
  homeProduct: "theme-home-product",
} as const;

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

function sameLook(left: StorefrontThemeDocument, right: StorefrontThemeDocument): boolean {
  return same(left.tokens, right.tokens) && same(left.blocks, right.blocks) && same(left.pages, right.pages);
}

/** A template an app offers: its key (`<app id>/<template id>`), name, app and look. */
export interface AppTemplateEntry {
  key: string;
  name: string;
  description: string | null;
  app: ThemeApp;
  theme: StorefrontAppTemplateTheme;
}

/** The active apps' templates, each as this document version reads it (one that does not parse is left out). */
export function appTemplates(apps: readonly ThemeApp[]): AppTemplateEntry[] {
  return apps.flatMap((app) => app.templates.flatMap((template) => {
    const theme = readStorefrontAppTemplateTheme(template.theme);
    return theme ? [{ key: template.key, name: template.name, description: template.description, app, theme }] : [];
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
  return new Map(apps.flatMap((app) => app.productBlocks.map((block) => [block.key, { app, block }] as const)));
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
