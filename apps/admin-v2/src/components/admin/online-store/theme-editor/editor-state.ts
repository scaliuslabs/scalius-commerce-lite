/**
 * The theme editor's client state: the working document with undo and redo
 * history (it survives autosave: saving never touches it), and the edits a
 * merchant makes to a page: sections and the template's fixed part as one
 * ordered list, blocks inside sections, and AI drafts marked until opened.
 */
import { PLUGIN_HOME_SECTIONS_MAX } from "@scalius/shared/plugins/storefront";
import {
  STOREFRONT_DEFAULT_FOCAL_POINT,
  STOREFRONT_MAX_SECTIONS,
  storefrontNextSectionId,
  storefrontSectionDefault,
  storefrontSettingAt,
  storefrontSettingWith,
  type StorefrontAppSection,
  type StorefrontSection,
  type StorefrontSectionType,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import type { ThemeApp, ThemeAppSection } from "~/lib/api-query-options/online-store";
import { appValuesInvalid, type AppSettingValues } from "../schema-form/app-settings";
import { settingDefault, type ListSpec, type SettingSpec } from "../schema-form/introspect";
import { sectionSettingSpec } from "../schema-form/registry-forms";

type Theme = StorefrontThemeDocument;
type Section = StorefrontSection;

// ─── History ───────────────────────────────────────────────────────────────

/** Edits to the same field within this window are one undo step (typing a heading). */
export const HISTORY_COALESCE_MS = 1000;
export const HISTORY_LIMIT = 100;

export interface EditorHistory {
  past: Theme[];
  present: Theme;
  future: Theme[];
  /** The field the last edit changed, so typing in it is one undo step. */
  last: { key: string; at: number } | null;
}

export type EditorAction =
  | { type: "edit"; update: (theme: Theme) => Theme; at: number }
  | { type: "undo" }
  | { type: "redo" }
  /** A newer saved draft under the edits (a reload after a conflict, a restore): history starts again from it. */
  | { type: "replace"; theme: Theme }
  /** The merchant opened an AI-drafted section: its mark goes, in every step, so undo never brings it back. */
  | { type: "opened"; id: string };

export function startHistory(theme: Theme): EditorHistory {
  return { past: [], present: theme, future: [], last: null };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * The path of the one value an edit changed (`pages.home.1.settings.title`),
 * or null when it changed several or the shape. Unchanged branches keep
 * their identity, so only the changed branch is walked.
 */
export function changedLeaf(before: unknown, after: unknown, path = ""): string | null {
  if (before === after) return null;
  if (!isRecord(before) || !isRecord(after) || Array.isArray(before) !== Array.isArray(after)) {
    return typeof before === typeof after && !isRecord(before) ? path : null;
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  let found: string | null = null;
  for (const key of keys) {
    if (before[key] === after[key]) continue;
    if (!(key in before) || !(key in after) || found !== null) return null;
    found = changedLeaf(before[key], after[key], path ? `${path}.${key}` : key);
    if (found === null) return null;
  }
  return found;
}

/** Every section list of a document, rewritten by `update` (unchanged lists keep their identity). */
function mapSectionLists(theme: Theme, update: (sections: Section[]) => Section[]): Theme {
  const home = update(theme.pages.home);
  let changed = home !== theme.pages.home;
  const landing = Object.fromEntries(Object.entries(theme.pages.landing).map(([slug, page]) => {
    const sections = update(page.sections);
    if (sections !== page.sections) changed = true;
    return [slug, sections === page.sections ? page : { ...page, sections }];
  }));
  const templates = Object.fromEntries(Object.entries(theme.pages.templates).map(([kind, template]) => {
    const sections = update(template.sections);
    if (sections !== template.sections) changed = true;
    return [kind, sections === template.sections ? template : { ...template, sections }];
  })) as Theme["pages"]["templates"];
  return changed ? { ...theme, pages: { ...theme.pages, home, landing, templates } } : theme;
}

/** The document without the AI mark on one section (wherever it is). */
export function withoutAiMark(theme: Theme, id: string): Theme {
  return mapSectionLists(theme, (sections) => sections.some((section) => section.id === id && section.aiDraft)
    ? sections.map((section) => {
      if (section.id !== id || !section.aiDraft) return section;
      const { aiDraft: _mark, ...rest } = section;
      return rest as Section;
    })
    : sections);
}

/** Every AI-drafted section no one has opened yet, with where it is. */
export function unopenedAiSections(theme: Theme): Section[] {
  return [
    ...theme.pages.home,
    ...Object.values(theme.pages.landing).flatMap((page) => page.sections),
    ...Object.values(theme.pages.templates).flatMap((template) => template.sections),
  ].filter((section) => section.aiDraft === true);
}

export function editorHistory(state: EditorHistory, action: EditorAction): EditorHistory {
  switch (action.type) {
    case "edit": {
      const next = action.update(state.present);
      if (next === state.present) return state;
      // Typing in one field (the same value changing again within a moment) is one undo step.
      const key = changedLeaf(state.present, next);
      const merge = key !== null && state.last?.key === key && action.at - state.last.at < HISTORY_COALESCE_MS;
      return {
        past: merge ? state.past : [...state.past, state.present].slice(-HISTORY_LIMIT),
        present: next,
        future: [],
        last: key === null ? null : { key, at: action.at },
      };
    }
    case "undo": {
      const previous = state.past.at(-1);
      if (!previous) return state;
      return { past: state.past.slice(0, -1), present: previous, future: [state.present, ...state.future], last: null };
    }
    case "redo": {
      const [next, ...rest] = state.future;
      if (!next) return state;
      return { past: [...state.past, state.present], present: next, future: rest, last: null };
    }
    case "replace":
      return startHistory(action.theme);
    case "opened": {
      const present = withoutAiMark(state.present, action.id);
      if (present === state.present) return state;
      return {
        ...state,
        past: state.past.map((step) => withoutAiMark(step, action.id)),
        present,
        future: state.future.map((step) => withoutAiMark(step, action.id)),
      };
    }
  }
}

// ─── A page's items: its sections and a template's fixed part ──────────────

/** One row of a page's body: a section, or a template's fixed part. */
export type PageItem = { kind: "section"; section: Section } | { kind: "fixed" };

/** A page's sections as one ordered list, with a template's fixed part at its place (`main`). */
export function pageItems(sections: readonly Section[], main: number | null): PageItem[] {
  const items: PageItem[] = sections.map((section) => ({ kind: "section", section }));
  if (main !== null) items.splice(Math.max(0, Math.min(main, sections.length)), 0, { kind: "fixed" });
  return items;
}

/** The sections and the fixed part's place back from the ordered list. */
export function fromPageItems(items: readonly PageItem[]): { sections: Section[]; main: number | null } {
  const fixed = items.findIndex((item) => item.kind === "fixed");
  return {
    sections: items.flatMap((item) => item.kind === "section" ? [item.section] : []),
    main: fixed < 0 ? null : fixed,
  };
}

/** The list with one item moved from one place to another (unchanged out of range). */
export function moveItem<Item>(items: readonly Item[], from: number, to: number): Item[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return [...items];
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}


// ─── Sections ──────────────────────────────────────────────────────────────

/**
 * Only one hero leads a page: a store adds or copies it once. A page draws
 * at most `PLUGIN_HOME_SECTIONS_MAX` app sections (later ones render
 * nothing), so the editor stops there.
 */
export function canAddSectionType(sections: readonly Section[], type: Section["type"]): boolean {
  if (sections.length >= STOREFRONT_MAX_SECTIONS) return false;
  if (type === "hero") return !sections.some((section) => section.type === "hero");
  if (type === "app") return sections.filter((section) => section.type === "app").length < PLUGIN_HOME_SECTIONS_MAX;
  return true;
}

/** Why a type cannot be added to these sections, or null when it can. */
export function addBlockedReason(sections: readonly Section[], type: Section["type"]): "limit" | "one-hero" | "app-limit" | null {
  if (sections.length >= STOREFRONT_MAX_SECTIONS) return "limit";
  if (type === "hero" && sections.some((section) => section.type === "hero")) return "one-hero";
  if (type === "app" && !canAddSectionType(sections, type)) return "app-limit";
  return null;
}

/** A platform section of a type at its defaults, with a free id. */
export function newSection(type: StorefrontSectionType, sections: readonly Section[]): Section {
  return storefrontSectionDefault(type, storefrontNextSectionId(type, sections)) as Section;
}

/** An app's section (`<plugin id>/<type>`) with the app's default values, with a free id. */
export function newAppSection(app: string, values: AppSettingValues, sections: readonly Section[]): StorefrontAppSection {
  return { id: storefrontNextSectionId("app", sections), type: "app", version: 1, settings: { app, values: { ...values } } };
}

/** Items with a section inserted at a place in the list (the end when out of range). */
export function insertItem(items: readonly PageItem[], section: Section, at: number): PageItem[] {
  const next = [...items];
  next.splice(Math.max(0, Math.min(at, next.length)), 0, { kind: "section", section });
  return next;
}

/** A copy of a section with its settings, right after it (null when the page cannot take another). */
export function duplicateSection(items: readonly PageItem[], id: string): { items: PageItem[]; id: string } | null {
  const sections = fromPageItems(items).sections;
  const index = items.findIndex((item) => item.kind === "section" && item.section.id === id);
  const source = index >= 0 ? (items[index] as { section: Section }).section : null;
  if (!source || !canAddSectionType(sections, source.type)) return null;
  const copyId = storefrontNextSectionId(source.type, sections);
  const { aiDraft: _mark, ...copy } = structuredClone(source);
  return { items: insertItem(items, { ...copy, id: copyId } as Section, index + 1), id: copyId };
}

/** The items without a section, with what Undo needs to put it back. */
export function removeSection(items: readonly PageItem[], id: string): { items: PageItem[]; removed: Section; index: number } | null {
  const index = items.findIndex((item) => item.kind === "section" && item.section.id === id);
  if (index < 0) return null;
  return { items: items.filter((_, at) => at !== index), removed: (items[index] as { section: Section }).section, index };
}

/** A section's items with one section replaced (by id). */
export function mapSection(items: readonly PageItem[], id: string, update: (section: Section) => Section): PageItem[] {
  return items.map((item) => item.kind === "section" && item.section.id === id ? { kind: "section", section: update(item.section) } : item);
}

/** An app's homepage section as the workspace offers it, with its app. */
export interface AppSectionEntry {
  app: ThemeApp;
  section: ThemeAppSection;
}

/** The active apps' sections by key (`<plugin id>/<type>`). */
export function appSectionsByKey(apps: readonly ThemeApp[]): ReadonlyMap<string, AppSectionEntry> {
  return new Map(apps.flatMap((app) => app.sections.map((section) => [section.key, { app, section }] as const)));
}

/**
 * True when an app section's values break what its app declares. A section
 * whose app is not active is not judged: it keeps its values for when the
 * app is back.
 */
export function appSectionInvalid(section: Section, byKey: ReadonlyMap<string, AppSectionEntry>): boolean {
  if (section.type !== "app") return false;
  const entry = byKey.get(section.settings.app);
  return entry !== undefined && appValuesInvalid(entry.section.settings, section.settings.values);
}

/** Sections an AI drafted, made the page's own: fresh ids, marked until opened. */
export function draftedSections(drafted: readonly Section[], sections: readonly Section[]): Section[] {
  const added: Section[] = [];
  for (const section of drafted) {
    const id = storefrontNextSectionId(section.type, [...sections, ...added]);
    added.push({ ...section, id, aiDraft: true } as Section);
  }
  return added;
}

// ─── Blocks (the items of a section's lists) ───────────────────────────────

/** The spec of one block list of a section type (`slides`, `source.items`), when it is a list. */
export function blockListSpec(type: StorefrontSectionType, path: string, settings: unknown): ListSpec | null {
  let spec: SettingSpec | undefined = sectionSettingSpec(type);
  let value: unknown = settings;
  for (const key of path.split(".")) {
    if (!spec) return null;
    if (spec.kind === "variants") {
      const discriminator: unknown = (value as Record<string, unknown> | null)?.[spec.key];
      spec = spec.options.find((option) => option.value === discriminator)?.spec;
    }
    if (spec?.kind !== "object") return null;
    spec = spec.fields.find((field) => field.key === key)?.spec;
    value = (value as Record<string, unknown> | null)?.[key];
  }
  return spec?.kind === "list" ? spec : null;
}

/** A section's block list (empty when the section's layout has none). */
export function blockList(section: Section, path: string): unknown[] {
  const list = storefrontSettingAt(section.settings, path);
  return Array.isArray(list) ? list : [];
}

function withBlockList(section: Section, path: string, list: unknown[]): Section {
  return { ...section, settings: storefrontSettingWith(section.settings, path, list) } as Section;
}

/** A new block at its defaults (a slide's focal points centred), or null when the list is full or absent. */
export function newBlock(section: Section, path: string): unknown {
  if (section.type === "app") return null;
  const spec = blockListSpec(section.type, path, section.settings);
  if (!spec || (spec.max !== null && blockList(section, path).length >= spec.max)) return null;
  const value = settingDefault({ ...spec.item, nullable: false });
  if (path === "slides" && value && typeof value === "object") {
    return { ...value, focalPoint: { ...STOREFRONT_DEFAULT_FOCAL_POINT } };
  }
  return value;
}

export function addBlock(section: Section, path: string): Section | null {
  const block = newBlock(section, path);
  return block === null ? null : withBlockList(section, path, [...blockList(section, path), block]);
}

export function duplicateBlock(section: Section, path: string, index: number): Section | null {
  const list = blockList(section, path);
  const spec = section.type === "app" ? null : blockListSpec(section.type, path, section.settings);
  if (index < 0 || index >= list.length || (spec?.max !== null && spec?.max !== undefined && list.length >= spec.max)) return null;
  const next = [...list];
  next.splice(index + 1, 0, structuredClone(list[index]));
  return withBlockList(section, path, next);
}

export function removeBlock(section: Section, path: string, index: number): Section {
  return withBlockList(section, path, blockList(section, path).filter((_, at) => at !== index));
}

export function moveBlock(section: Section, path: string, from: number, to: number): Section {
  return withBlockList(section, path, moveItem(blockList(section, path), from, to));
}

export function toggleBlockHidden(section: Section, path: string, index: number): Section {
  return withBlockList(section, path, blockList(section, path).map((item, at) => {
    if (at !== index || typeof item !== "object" || item === null) return item;
    const { hidden, ...rest } = item as Record<string, unknown>;
    return hidden === true ? rest : { ...rest, hidden: true };
  }));
}

/** Whether a block list would still hold its minimum after removing one (a tab strip keeps two). */
export function canRemoveBlock(section: Section, path: string): boolean {
  if (section.type === "app") return false;
  const spec = blockListSpec(section.type, path, section.settings);
  return blockList(section, path).length > (spec?.min ?? 0);
}
