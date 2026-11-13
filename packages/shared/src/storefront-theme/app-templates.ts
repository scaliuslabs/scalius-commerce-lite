// Templates installed apps offer (`storefront.templates` of a manifest): a
// ready-made look the template library applies in one step, like a built-in
// template. A template may set the tokens, any blocks, the units app skins draw
// and the homepage sections; the merchant's brand, landing pages, page
// templates and other content stay. A declaration is written for one document
// version (`themeVersion`); the API runs it through the stored documents'
// upgrade chain and lists only what then parses against the live schema,
// reporting the rest on the app's page. A block a template names may leave
// required nested fields out: they take the default theme's, and the block is
// then validated as any other; an optional field it leaves out stays out (the
// style's own value). The applied document is checked whole
// (contrast included) when it is saved, so an app can never write a theme the
// storefront cannot draw.

import { z } from "zod";
import { storefrontThemeAppsSchema } from "./apps";
import { storefrontThemeBlocksSchema } from "./blocks";
import { storefrontSectionListSchema, type StorefrontSection } from "./sections";
import { STOREFRONT_LIGHT_COLOR_SCHEME, storefrontDarkColorsMissing, storefrontThemeTokensSchema, storefrontTokensKeepingColorScheme } from "./tokens";
import { storefrontThemeWithReadableDarkColors, type StorefrontThemeDocument } from "./document";
import { StorefrontThemeUpgradeError, upgradeStorefrontThemeDocument } from "./upgrade";
import { DEFAULT_STOREFRONT_THEME } from "./templates";
import { carryStorefrontHome, storefrontTemplateHome, storefrontThemeTemplateKey, type StorefrontHomeCarry } from "./content";
import type { StorefrontThemeSkins } from "./apps";
import {
  resolveStorefrontHandles,
  storefrontHandlePlaceholder,
  type StorefrontHandleLookup,
  type StorefrontHandleRef,
} from "./handles";

/**
 * The theme document version of a template or page preset that does not
 * state one (`themeVersion`): the version the field arrived with.
 */
export const STOREFRONT_DECLARATION_THEME_VERSION = 10;

export const storefrontAppTemplateThemeSchema = z.object({
  tokens: storefrontThemeTokensSchema.optional(),
  blocks: storefrontThemeBlocksSchema.partial().optional(),
  apps: storefrontThemeAppsSchema.omit({ template: true, templateSkins: true }).optional(),
  /** The homepage sections. */
  sections: storefrontSectionListSchema.optional(),
}).strict().superRefine((value, context) => {
  // As every theme: dark colours whenever its scheme or switch can show them, so an applied template always saves.
  if (value.tokens && storefrontDarkColorsMissing(value.tokens)) {
    context.addIssue({ code: "custom", path: ["tokens", "darkColors"], message: "A dark or device colour scheme, or the buyer's switch, needs the dark colours." });
  }
});
export type StorefrontAppTemplateTheme = z.infer<typeof storefrontAppTemplateThemeSchema>;

/** A declaration read at this store's version: its value, or the first reason it does not fit. */
export type StorefrontAppThemeRead<Value> = { ok: true; value: Value } | { ok: false; problem: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issueText(error: z.ZodError): string {
  const issue = error.issues[0];
  return `${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}`;
}

/** Parts of a document at `version`, upgraded to the current version (`pages.home` carries sections). */
function upgradeParts(parts: Record<string, unknown>, version: number): StorefrontAppThemeRead<Record<string, unknown>> {
  try {
    const { version: _version, ...upgraded } = upgradeStorefrontThemeDocument({ ...parts, version });
    return { ok: true, value: upgraded };
  } catch (error) {
    return { ok: false, problem: error instanceof StorefrontThemeUpgradeError ? error.message : "It did not upgrade." };
  }
}

/** A handle a declaration names that this store does not have, and the section left out for it (null: outside sections). */
export interface StorefrontUnresolvedHandle extends StorefrontHandleRef {
  sectionId: string | null;
}

/** A declaration read against a store: its value, and the sections left out for a handle the store does not have. */
export type StorefrontAppThemeResolvedRead<Value> =
  | { ok: true; value: Value; unresolved: StorefrontUnresolvedHandle[] }
  | { ok: false; problem: string };

const placeholderLookup: StorefrontHandleLookup = (ref) => storefrontHandlePlaceholder(ref);

/**
 * Sections with their handles resolved (`handles.ts`): a section naming a
 * handle the lookup does not know is left out and reported, so the rest of
 * the page still applies.
 */
function resolveSectionHandles(sections: unknown, lookup: StorefrontHandleLookup): { sections: unknown; unresolved: StorefrontUnresolvedHandle[] } {
  if (!Array.isArray(sections)) {
    const { value, unresolved } = resolveStorefrontHandles(sections, lookup);
    return { sections: value, unresolved: unresolved.map((ref) => ({ ...ref, sectionId: null })) };
  }
  const unresolved: StorefrontUnresolvedHandle[] = [];
  const kept: unknown[] = [];
  for (const section of sections) {
    const read = resolveStorefrontHandles(section, lookup);
    if (read.unresolved.length === 0) {
      kept.push(read.value);
      continue;
    }
    const sectionId = isRecord(section) && typeof section.id === "string" ? section.id : null;
    unresolved.push(...read.unresolved.map((ref) => ({ ...ref, sectionId })));
  }
  return { sections: kept, unresolved };
}

/** The handles outside the template's sections (blocks, skins): one the store lacks makes the template unusable. */
function resolveTemplateParts(parts: Record<string, unknown>, lookup: StorefrontHandleLookup): StorefrontAppThemeRead<Record<string, unknown>> {
  const { value, unresolved } = resolveStorefrontHandles(parts, lookup);
  const first = unresolved[0];
  return first ? { ok: false, problem: `No ${first.kind} has the handle ${first.handle}.` } : { ok: true, value: value as Record<string, unknown> };
}

/** The value at `path` inside `root`; undefined where the path leaves the objects. */
function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let value = root;
  for (const key of path) {
    if (!isRecord(value) && !Array.isArray(value)) return undefined;
    value = (value as Record<PropertyKey, unknown>)[key];
  }
  return value;
}

/**
 * A required field whose right default depends on a sibling the template
 * named, not on the default theme: listing filters in the bar-dropdowns style
 * open on demand only, so their `openByDefault` is false (the default theme's
 * sidebar opens its groups). Undefined: the default theme's value.
 */
function styleFallback(path: readonly PropertyKey[], parent: Record<string, unknown>): unknown {
  const [block, field, key] = path;
  if (block === "listing" && field === "filters" && key === "openByDefault" && path.length === 3) {
    return parent.style === "bar-dropdowns" ? false : undefined;
  }
  return undefined;
}

/** A list, or an object with a list anywhere inside it. */
function holdsList(value: unknown): boolean {
  return Array.isArray(value) || (isRecord(value) && Object.values(value).some(holdsList));
}

/**
 * Fills, in the template's blocks, each field the schema requires and the
 * template leaves out, from the default theme's block at the same place
 * (`issues` name them: a required field missing is an issue at its path).
 * Optional fields are never filled: absent means the style's own value. A
 * list is never filled or merged (a receipt's mandatory cards stay exactly
 * the template's, so dropping or repeating one is refused). A block naming
 * another `variant` than the default's takes nothing from it below that
 * variant (each variant has its own settings). An object the template leaves
 * out is filled only when no list sits anywhere inside it: one that holds a
 * list is refused, as the list alone would be. Returns whether it filled any.
 * `defaults` is the default theme's blocks (a test gives its own).
 */
export function fillRequiredBlockFields(
  candidate: Record<string, unknown>,
  issues: z.ZodError["issues"],
  defaults: Record<string, unknown> = DEFAULT_STOREFRONT_THEME.blocks as unknown as Record<string, unknown>,
): boolean {
  let filled = false;
  for (const issue of issues) {
    const [root, ...path] = issue.path;
    if (root !== "blocks" || path.length < 2) continue;
    const parent = valueAt(candidate.blocks, path.slice(0, -1));
    const key = path.at(-1)!;
    if (!isRecord(parent) || parent[key as string] !== undefined) continue;
    const fallback = valueAt(defaults, path);
    // A list is the template's whole say or nothing: never filled, never
    // merged into element by element (a receipt's mandatory cards, a
    // product's modules, an order of filters), so a list that drops or
    // repeats a member is refused as written.
    if (fallback === undefined || holdsList(fallback) || path.some((segment) => typeof segment === "number")) continue;
    // Never across a variant the template changed.
    const crossesVariant = path.slice(0, -1).some((_, depth) => {
      const declared = valueAt(candidate.blocks, path.slice(0, depth + 1));
      const standard = valueAt(defaults, path.slice(0, depth + 1));
      return isRecord(declared) && isRecord(standard) && "variant" in declared && declared.variant !== standard.variant;
    });
    if (crossesVariant) continue;
    parent[key as string] = structuredClone(styleFallback(path, parent) ?? fallback);
    filled = true;
  }
  return filled;
}

function readTemplate(value: unknown, themeVersion: number, lookup: StorefrontHandleLookup): StorefrontAppThemeResolvedRead<StorefrontAppTemplateTheme> {
  if (!isRecord(value)) return { ok: false, problem: "The template's theme is not an object." };
  const { sections: declared, ...declaredRest } = value;
  const rest = resolveTemplateParts(declaredRest, lookup);
  if (!rest.ok) return rest;
  const { sections, unresolved } = declared === undefined ? { sections: undefined, unresolved: [] } : resolveSectionHandles(declared, lookup);
  const upgraded = upgradeParts(sections === undefined ? rest.value : { ...rest.value, pages: { home: sections } }, themeVersion);
  if (!upgraded.ok) return upgraded;
  const { pages, ...parts } = upgraded.value;
  const home = isRecord(pages) ? pages.home : undefined;
  // A block may leave required fields out: each takes the default theme's, then the whole is checked again.
  const candidate: Record<string, unknown> = structuredClone(home === undefined ? parts : { ...parts, sections: home });
  let parsed = storefrontAppTemplateThemeSchema.safeParse(candidate);
  for (let round = 0; !parsed.success && round < 16 && fillRequiredBlockFields(candidate, parsed.error.issues); round += 1) {
    parsed = storefrontAppTemplateThemeSchema.safeParse(candidate);
  }
  return parsed.success ? { ok: true, value: parsed.data, unresolved } : { ok: false, problem: issueText(parsed.error) };
}

/**
 * An app template's theme, written for document version `themeVersion`, at
 * this store's version: upgraded through the chain, then strictly parsed.
 * Handles (`handles.ts`) stand in for ids here, so the shape is checked
 * without a store; `resolveStorefrontAppTemplateTheme` reads it against one.
 */
export function checkStorefrontAppTemplateTheme(value: unknown, themeVersion: number): StorefrontAppThemeRead<StorefrontAppTemplateTheme> {
  const read = readTemplate(value, themeVersion, placeholderLookup);
  return read.ok ? { ok: true, value: read.value } : read;
}

/**
 * An app template's theme read against this store: every handle replaced by
 * the id it names; a homepage section naming a handle the store lacks is
 * left out and reported (`unresolved`).
 */
export function resolveStorefrontAppTemplateTheme(
  value: unknown,
  themeVersion: number,
  lookup: StorefrontHandleLookup,
): StorefrontAppThemeResolvedRead<StorefrontAppTemplateTheme> {
  return readTemplate(value, themeVersion, lookup);
}

/**
 * The product card fields a template's theme names (`blocks.card.fields`,
 * `<namespace>.<key>`), as declared: what to look up before
 * `withStorefrontCardFields`.
 */
export function storefrontAppTemplateCardFields(value: unknown): string[] {
  const blocks = isRecord(value) ? value.blocks : undefined;
  const card = isRecord(blocks) ? blocks.card : undefined;
  const fields = isRecord(card) ? card.fields : undefined;
  return Array.isArray(fields) ? fields.filter((field): field is string => typeof field === "string") : [];
}

/**
 * The template keeping only the card fields this store's product cards can
 * show (`shown`), and the ones left out. A custom field is the store's data,
 * not the app's: a card field the store has no storefront-visible product
 * field for is left out, as a section naming a missing handle is, so the rest
 * of the template applies.
 */
export function withStorefrontCardFields(
  template: StorefrontAppTemplateTheme,
  shown: (field: string) => boolean,
): { theme: StorefrontAppTemplateTheme; omitted: string[] } {
  const card = template.blocks?.card;
  const omitted = card?.fields?.filter((field) => !shown(field)) ?? [];
  if (!card?.fields || omitted.length === 0) return { theme: template, omitted };
  const fields = card.fields.filter(shown);
  return { theme: { ...template, blocks: { ...template.blocks, card: { ...card, fields } } }, omitted };
}

/** The template's theme at this store's version, or null when it does not fit. */
export function readStorefrontAppTemplateTheme(value: unknown, themeVersion: number): StorefrontAppTemplateTheme | null {
  const read = checkStorefrontAppTemplateTheme(value, themeVersion);
  return read.ok ? read.value : null;
}

type StorefrontTemplateSkins = NonNullable<NonNullable<StorefrontThemeDocument["apps"]>["templateSkins"]>;

/**
 * The document's `apps` after an app template: the template's unit skins,
 * and the merchant's own skins on the units it does not skin. A skin is the
 * merchant's own unless the template the store is on brought it: a built-in
 * template brings none, and an app template's are recorded when it is
 * applied (`templateSkins`, each unit's skin key), so a re-applied template
 * that dropped a skin drops it here too. A document applied before the
 * record existed counts every skin as its template's. The new template's
 * skins are recorded the same way.
 */
function appsAfterTemplate(document: StorefrontThemeDocument, key: string, template: StorefrontAppTemplateTheme): NonNullable<StorefrontThemeDocument["apps"]> {
  const current: StorefrontThemeSkins = document.apps?.skins ?? {};
  const brought: StorefrontTemplateSkins | null = storefrontTemplateHome(storefrontThemeTemplateKey(document)) !== null
    ? {}
    : document.apps?.templateSkins ?? null;
  const own = brought === null
    ? {}
    : Object.fromEntries(Object.entries(current).filter(([unit, skin]) => skin && brought[unit as keyof StorefrontTemplateSkins] !== skin.app));
  const skins: StorefrontThemeSkins = { ...own, ...template.apps?.skins };
  const recorded = Object.fromEntries(Object.entries(template.apps?.skins ?? {}).flatMap(([unit, skin]) => skin ? [[unit, skin.app]] : [])) as StorefrontTemplateSkins;
  return {
    ...(template.apps ?? {}),
    ...(Object.keys(skins).length > 0 ? { skins } : {}),
    template: key,
    ...(Object.keys(recorded).length > 0 ? { templateSkins: recorded } : {}),
  };
}

/**
 * The document with an app template applied: its tokens replace the
 * document's, the blocks and unit skins it names replace those
 * (`appsAfterTemplate` says which of the merchant's skins stay), its
 * sections become the homepage's with the merchant's carried in
 * (`carryStorefrontHome`: content follows its type, a section no new one
 * takes stays hidden), and the document records the template it came from
 * (`apps.template`). The merchant's colour scheme,
 * dark colours and switch stay unless the template shows dark colours of its
 * own (`storefrontTokensKeepingColorScheme`). `fromHome` is the homepage the
 * document's own template started with, when it is an app's.
 */
export function applyStorefrontAppTemplate(
  document: StorefrontThemeDocument,
  key: string,
  template: StorefrontAppTemplateTheme,
  fromHome?: readonly StorefrontSection[] | null,
): StorefrontThemeDocument {
  return applyStorefrontAppTemplateCarry(document, key, template, fromHome).theme;
}

/** `applyStorefrontAppTemplate` with what happened to the merchant's homepage sections (null: the template keeps the homepage). */
export function applyStorefrontAppTemplateCarry(
  document: StorefrontThemeDocument,
  key: string,
  template: StorefrontAppTemplateTheme,
  fromHome?: readonly StorefrontSection[] | null,
): { theme: StorefrontThemeDocument; carry: StorefrontHomeCarry | null } {
  const carry = template.sections
    ? carryStorefrontHome(template.sections, document.pages.home, { from: storefrontThemeTemplateKey(document), to: key, fromHome })
    : null;
  return {
    carry,
    theme: storefrontThemeWithReadableDarkColors({
      ...document,
      tokens: template.tokens ? storefrontTokensKeepingColorScheme(template.tokens, document.tokens) : document.tokens,
      blocks: { ...document.blocks, ...(template.blocks ?? {}) },
      apps: appsAfterTemplate(document, key, template),
      pages: { ...document.pages, home: carry ? carry.home : document.pages.home },
    }),
  };
}

/**
 * A page preset's sections (`storefront.pagePresets`), written for document
 * version `themeVersion`, at this store's version: what a new landing page
 * starts with.
 */
export function checkStorefrontPagePresetSections(value: unknown, themeVersion: number): StorefrontAppThemeRead<StorefrontSection[]> {
  const read = readPreset(value, themeVersion, placeholderLookup);
  return read.ok ? { ok: true, value: read.value } : read;
}

/** A page preset's sections read against this store, as `resolveStorefrontAppTemplateTheme` reads a template's. */
export function resolveStorefrontPagePresetSections(
  value: unknown,
  themeVersion: number,
  lookup: StorefrontHandleLookup,
): StorefrontAppThemeResolvedRead<StorefrontSection[]> {
  return readPreset(value, themeVersion, lookup);
}

function readPreset(value: unknown, themeVersion: number, lookup: StorefrontHandleLookup): StorefrontAppThemeResolvedRead<StorefrontSection[]> {
  const { sections, unresolved } = resolveSectionHandles(value, lookup);
  const upgraded = upgradeParts({ pages: { home: sections } }, themeVersion);
  if (!upgraded.ok) return upgraded;
  const pages = upgraded.value.pages;
  const parsed = storefrontSectionListSchema.safeParse(isRecord(pages) ? pages.home : undefined);
  if (!parsed.success) return { ok: false, problem: issueText(parsed.error) };
  return parsed.data.length > 0 ? { ok: true, value: parsed.data, unresolved } : { ok: false, problem: "The preset has no sections." };
}

/** A page preset's sections at this store's version, or null when they do not fit. */
export function readStorefrontPagePresetSections(value: unknown, themeVersion: number): StorefrontSection[] | null {
  const read = checkStorefrontPagePresetSections(value, themeVersion);
  return read.ok ? read.value : null;
}

/** An app's theme declarations as its manifest has them (`storefront.templates`, `storefront.pagePresets`). */
export interface StorefrontAppThemeDeclarations {
  templates: ReadonlyArray<{ id: string; name: string; themeVersion?: number; theme: unknown }>;
  pagePresets: ReadonlyArray<{ id: string; name: string; themeVersion?: number; sections: unknown }>;
}

/** A template or page preset this store's theme cannot use, with the first reason. */
export interface StorefrontAppThemeProblem {
  kind: "template" | "page-preset";
  id: string;
  name: string;
  problem: string;
}

/**
 * The app's templates and page presets that do not fit this store's theme
 * document after the upgrade chain: the template library leaves them out,
 * and the app's page reports them.
 */
export function storefrontAppThemeProblems(storefront: StorefrontAppThemeDeclarations): StorefrontAppThemeProblem[] {
  const problems: StorefrontAppThemeProblem[] = [];
  for (const template of storefront.templates) {
    const read = checkStorefrontAppTemplateTheme(template.theme, template.themeVersion ?? STOREFRONT_DECLARATION_THEME_VERSION);
    if (!read.ok) problems.push({ kind: "template", id: template.id, name: template.name, problem: read.problem });
  }
  for (const preset of storefront.pagePresets) {
    const read = checkStorefrontPagePresetSections(preset.sections, preset.themeVersion ?? STOREFRONT_DECLARATION_THEME_VERSION);
    if (!read.ok) problems.push({ kind: "page-preset", id: preset.id, name: preset.name, problem: read.problem });
  }
  return problems;
}
