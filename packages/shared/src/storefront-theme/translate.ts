// Theme text in the page's language (../storefront-theme.md, "Compatibility",
// translatable text). A presence read gets its translation context from a
// statement it already runs and resolves the document's own `translations`
// with the one fallback chain (`translationChain`, @scalius/shared/translations);
// `translateStorefrontTheme` then replaces the words in place, so every
// renderer and skin reads translated text from the document it already has.

import { resolveTranslatedField, translationChain, type TranslationContext } from "../translations";
import { translatePluginSettingValues, type PluginSettingsSchema } from "../plugins/settings-schema";
import { storefrontThemeDocumentSchema, type StorefrontThemeDocument } from "./document";
import { isStorefrontAppSection, type StorefrontSection } from "./sections";
import { STOREFRONT_BLOCK_TEXT, STOREFRONT_LANDING_TEXT, STOREFRONT_SECTION_TEXT, type StorefrontThemeTranslation } from "./text";

/** The page's words for one source text: its translation, or the source itself. */
export type StorefrontThemeText = (source: string) => string;

/** The settings schema of an active app surface by its `<plugin id>/<id>` key; null when there is none. */
export type StorefrontThemeAppSchemas = (kind: "section" | "skin" | "component", key: string) => PluginSettingsSchema | null;

function textOf(chain: readonly StorefrontThemeTranslation[]): StorefrontThemeText | null {
  if (chain.length === 0) return null;
  return (source) => {
    const resolved = resolveTranslatedField(chain, source, source);
    return typeof resolved === "string" ? resolved : source;
  };
}

/**
 * The document's words in a page's language and market: its translation rows
 * through `translationChain` (the page locale in its market, the page locale,
 * the default locale in the market, the default locale). Null when nothing
 * applies, so a store without translations reads as it is.
 */
export function storefrontThemeTextOf(
  document: Pick<StorefrontThemeDocument, "translations">,
  context: TranslationContext | null,
): StorefrontThemeText | null {
  if (!context || !document.translations?.length) return null;
  return textOf(translationChain(document.translations, context));
}

/** The value with the words at `path` (dotted; `*` is every list item) translated; the same value when none changes. */
function translateAt(value: unknown, path: readonly string[], text: StorefrontThemeText): unknown {
  if (path.length === 0) return typeof value === "string" && value.trim() !== "" ? text(value) : value;
  const [head, ...rest] = path;
  if (head === "*") {
    if (!Array.isArray(value)) return value;
    const items = value.map((item) => translateAt(item, rest, text));
    return items.some((item, index) => item !== value[index]) ? items : value;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value) || !Object.hasOwn(value, head!)) return value;
  const current = (value as Record<string, unknown>)[head!];
  const next = translateAt(current, rest, text);
  return next === current ? value : { ...value, [head!]: next };
}

function translatePaths(value: unknown, paths: readonly string[], text: StorefrontThemeText): unknown {
  return paths.reduce((current, path) => translateAt(current, path.split("."), text), value);
}

function translateValues(kind: "section" | "skin" | "component", key: string, values: unknown, text: StorefrontThemeText, apps: StorefrontThemeAppSchemas | null): unknown {
  const schema = apps?.(kind, key) ?? null;
  return schema ? translatePluginSettingValues(schema, values, text) : values;
}

function translateSection(section: StorefrontSection, text: StorefrontThemeText, apps: StorefrontThemeAppSchemas | null): StorefrontSection {
  if (isStorefrontAppSection(section)) {
    const values = translateValues("section", section.settings.app, section.settings.values, text, apps);
    return values === section.settings.values ? section : { ...section, settings: { ...section.settings, values: values as typeof section.settings.values } };
  }
  const settings = translatePaths(section.settings, STOREFRONT_SECTION_TEXT[section.type], text);
  const skin = section.skin;
  const skinValues = skin ? translateValues("skin", skin.app, skin.values, text, apps) : undefined;
  if (settings === section.settings && skinValues === skin?.values) return section;
  return {
    ...section,
    settings,
    ...(skin ? { skin: { ...skin, values: skinValues as typeof skin.values } } : {}),
  } as StorefrontSection;
}

function translateSections(sections: StorefrontSection[], text: StorefrontThemeText, apps: StorefrontThemeAppSchemas | null): StorefrontSection[] {
  const next = sections.map((section) => translateSection(section, text, apps));
  return next.some((section, index) => section !== sections[index]) ? next : sections;
}

function mapRecord<Value>(record: Record<string, Value>, map: (value: Value) => Value): Record<string, Value> {
  let next: Record<string, Value> | null = null;
  for (const [key, value] of Object.entries(record)) {
    const mapped = map(value);
    if (mapped !== value) (next ??= { ...record })[key] = mapped;
  }
  return next ?? record;
}

/** Every declared word of the document translated (no validation; the same document when nothing changes). */
function translatedDocument(document: StorefrontThemeDocument, text: StorefrontThemeText, apps: StorefrontThemeAppSchemas | null): StorefrontThemeDocument {
  const { pages, blocks } = document;
  const home = translateSections(pages.home, text, apps);
  const landing = mapRecord(pages.landing, (page) => {
    const words = translatePaths(page, STOREFRONT_LANDING_TEXT, text) as typeof page;
    const sections = translateSections(page.sections, text, apps);
    return words === page && sections === page.sections ? page : { ...words, sections };
  });
  const templates = mapRecord(pages.templates as Record<string, StorefrontThemeDocument["pages"]["templates"][keyof StorefrontThemeDocument["pages"]["templates"]]>, (template) => {
    const sections = translateSections(template.sections, text, apps);
    return sections === template.sections ? template : { ...template, sections };
  }) as StorefrontThemeDocument["pages"]["templates"];
  const topBar = translatePaths(blocks.topBar, STOREFRONT_BLOCK_TEXT.topBar.map((key) => `settings.${key}`), text) as typeof blocks.topBar;
  const footer = translatePaths(blocks.footer, STOREFRONT_BLOCK_TEXT.footer.map((key) => `settings.${key}`), text) as typeof blocks.footer;
  const productApps = blocks.product.apps;
  const appBlocks = productApps?.map((block) => {
    const values = translateValues("component", block.app, block.values, text, apps);
    return values === block.values ? block : { ...block, values: values as typeof block.values };
  });
  const product = appBlocks && appBlocks.some((block, index) => block !== productApps![index]) ? { ...blocks.product, apps: appBlocks } : blocks.product;
  const skins = document.apps?.skins;
  const translatedSkins = skins ? mapRecord(skins as Record<string, NonNullable<typeof skins[keyof typeof skins]>>, (skin) => {
    const values = translateValues("skin", skin.app, skin.values, text, apps);
    return values === skin.values ? skin : { ...skin, values: values as typeof skin.values };
  }) : skins;
  const pagesChanged = home !== pages.home || landing !== pages.landing || templates !== pages.templates;
  const blocksChanged = topBar !== blocks.topBar || footer !== blocks.footer || product !== blocks.product;
  if (!pagesChanged && !blocksChanged && translatedSkins === skins) return document;
  return {
    ...document,
    ...(blocksChanged ? { blocks: { ...blocks, topBar, footer, product } } : {}),
    ...(translatedSkins !== skins ? { apps: { ...document.apps, skins: translatedSkins } } : {}),
    ...(pagesChanged ? { pages: { ...pages, home, landing, templates } } : {}),
  };
}

/** The document as buyers get it: without its translations. */
function withoutTranslations(document: StorefrontThemeDocument): StorefrontThemeDocument {
  if (document.translations === undefined) return document;
  const { translations: _translations, ...rest } = document;
  return rest;
}

/**
 * The document in the page's words: every declared text replaced through
 * `text` (core section text paths, the announcement and footer words,
 * landing page titles and descriptions, and the `text`/`textarea` values of
 * the app surfaces `apps` knows), served without `translations`. A
 * translation that would break the document leaves it in its source words.
 */
export function translateStorefrontTheme(
  document: StorefrontThemeDocument,
  text: StorefrontThemeText | null,
  apps: StorefrontThemeAppSchemas | null = null,
): StorefrontThemeDocument {
  const source = withoutTranslations(document);
  if (!text) return source;
  const translated = translatedDocument(source, text, apps);
  if (translated === source) return source;
  const parsed = storefrontThemeDocumentSchema.safeParse(translated);
  return parsed.success ? parsed.data : source;
}

/**
 * Translations that do not fit where their words are (a translation longer
 * than a place allows): each with its row's path and the first problem. A
 * save refuses them, so a read never falls back to the source words.
 */
export function storefrontThemeTranslationProblems(document: StorefrontThemeDocument): Array<{ path: string; message: string }> {
  const source = withoutTranslations(document);
  const problems: Array<{ path: string; message: string }> = [];
  (document.translations ?? []).forEach((row, index) => {
    const text = textOf([row]);
    if (!text) return;
    const translated = translatedDocument(source, text, null);
    if (translated === source) return;
    const issue = storefrontThemeDocumentSchema.safeParse(translated).error?.issues[0];
    if (issue) problems.push({ path: `translations.${index}.fields`, message: `A ${row.locale} translation does not fit at ${issue.path.join(".")}: ${issue.message}` });
  });
  return problems;
}
