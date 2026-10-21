// Templates installed apps offer (`storefront.templates` of a manifest): a
// ready-made look the template library applies in one step, like a built-in
// template. A template may set the tokens, any blocks, the units app skins draw
// and the homepage sections; the merchant's brand, landing pages, page
// templates and other content stay. A declaration is written for one document
// version (`themeVersion`); the API runs it through the stored documents'
// upgrade chain and lists only what then parses against the live schema,
// reporting the rest on the app's page. The applied document is checked whole
// (contrast included) when it is saved, so an app can never write a theme the
// storefront cannot draw.

import { z } from "zod";
import { storefrontThemeAppsSchema } from "./apps";
import { storefrontThemeBlocksSchema } from "./blocks";
import { storefrontSectionListSchema, type StorefrontSection } from "./sections";
import { storefrontThemeTokensSchema } from "./tokens";
import type { StorefrontThemeDocument } from "./document";
import { StorefrontThemeUpgradeError, upgradeStorefrontThemeDocument } from "./upgrade";
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
  apps: storefrontThemeAppsSchema.omit({ template: true }).optional(),
  /** The homepage sections. */
  sections: storefrontSectionListSchema.optional(),
}).strict();
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
  const parsed = storefrontAppTemplateThemeSchema.safeParse(home === undefined ? parts : { ...parts, sections: home });
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

/** The template's theme at this store's version, or null when it does not fit. */
export function readStorefrontAppTemplateTheme(value: unknown, themeVersion: number): StorefrontAppTemplateTheme | null {
  const read = checkStorefrontAppTemplateTheme(value, themeVersion);
  return read.ok ? read.value : null;
}

/**
 * The document with an app template applied: its tokens, blocks and skins
 * replace the document's, its sections become the homepage's, and the
 * document records the template it came from (`apps.template`). A homepage
 * section whose id the template reuses keeps the merchant's values.
 */
export function applyStorefrontAppTemplate(
  document: StorefrontThemeDocument,
  key: string,
  template: StorefrontAppTemplateTheme,
): StorefrontThemeDocument {
  const previous = new Map(document.pages.home.map((section) => [section.id, section]));
  const home = template.sections
    ? template.sections.map((section) => {
      const kept = previous.get(section.id);
      return kept && kept.type === section.type ? kept : section;
    })
    : document.pages.home;
  return {
    ...document,
    tokens: template.tokens ?? document.tokens,
    blocks: { ...document.blocks, ...(template.blocks ?? {}) },
    apps: { ...(template.apps ?? {}), template: key },
    pages: { ...document.pages, home },
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
