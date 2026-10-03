/**
 * The theme editor's client state: the draft with undo and redo history,
 * section operations, and what a saved change means for the preview (swap
 * the changed sections, or load the page again).
 */
import { PLUGIN_HOME_SECTIONS_MAX } from "@scalius/shared/plugins/storefront";
import {
  STOREFRONT_MAX_SECTIONS,
  storefrontSectionDefault,
  type StorefrontAppSection,
  type StorefrontSection,
  type StorefrontSectionType,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import type { ThemeApp, ThemeAppSection } from "~/lib/api-query-options/online-store";
import { newSectionId } from "../SectionSettings";
import { appValuesInvalid, type AppSettingValues } from "../schema-form/app-settings";
import { pageSections, withPageSections, type EditorPage } from "./editor-pages";

type Theme = StorefrontThemeDocument;
type Section = StorefrontSection;

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
  /** A newer saved draft under the edits (after a conflict): history starts again from it. */
  | { type: "replace"; theme: Theme };

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
  }
}

// ─── Sections and blocks ───────────────────────────────────────────────────

/** The list with one item moved from one place to another (unchanged out of range). */
export function moveSectionTo<Item>(items: readonly Item[], from: number, to: number): Item[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return [...items];
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/**
 * Only one hero leads a page: a store adds or copies it once. A homepage
 * draws at most `PLUGIN_HOME_SECTIONS_MAX` app sections (later ones render
 * nothing), so the editor stops there.
 */
export function canAddSectionType(sections: readonly Section[], type: Section["type"]): boolean {
  if (sections.length >= STOREFRONT_MAX_SECTIONS) return false;
  if (type === "hero") return !sections.some((section) => section.type === "hero");
  if (type === "app") return sections.filter((section) => section.type === "app").length < PLUGIN_HOME_SECTIONS_MAX;
  return true;
}

/** A new section of a type at its defaults, after `afterIndex` (or last). */
export function addSection(sections: readonly Section[], type: StorefrontSectionType, afterIndex = sections.length - 1): { sections: Section[]; id: string } {
  const id = newSectionId(type, sections);
  const next = [...sections];
  next.splice(afterIndex + 1, 0, storefrontSectionDefault(type, id) as Section);
  return { sections: next, id };
}

/**
 * A new app section (`<plugin id>/<type>`) with the merchant's starting
 * values (the app's defaults), after `afterIndex` (or last).
 */
export function addAppSection(
  sections: readonly Section[],
  app: string,
  values: AppSettingValues,
  afterIndex = sections.length - 1,
): { sections: Section[]; id: string } {
  const id = newSectionId("app", sections);
  const section: StorefrontAppSection = { id, type: "app", version: 1, settings: { app, values: { ...values } } };
  const next = [...sections];
  next.splice(afterIndex + 1, 0, section);
  return { sections: next, id };
}

/** An app's homepage section as the workspace offers it, with its app. */
export interface AppSectionEntry {
  app: ThemeApp;
  section: ThemeAppSection;
}

/** The active apps' homepage sections by key (`<plugin id>/<type>`). */
export function appSectionsByKey(apps: readonly ThemeApp[]): ReadonlyMap<string, AppSectionEntry> {
  return new Map(apps.flatMap((app) => app.sections.map((section) => [section.key, { app, section }] as const)));
}

/**
 * True while an app section's values break what its app declares. A section
 * whose app is not active is not judged: it keeps its values for when the
 * app is back.
 */
export function appSectionsInvalid(sections: readonly Section[], byKey: ReadonlyMap<string, AppSectionEntry>): boolean {
  return sections.some((section) => {
    if (section.type !== "app") return false;
    const entry = byKey.get(section.settings.app);
    return entry !== undefined && appValuesInvalid(entry.section.settings, section.settings.values);
  });
}

/** The sections with one app section's values replaced (other sections untouched). */
export function setAppSectionValues(sections: readonly Section[], id: string, values: AppSettingValues): Section[] {
  return sections.map((section) =>
    section.id === id && section.type === "app" ? { ...section, settings: { ...section.settings, values } } : section);
}

/** A copy of a section with its settings, right after it. */
export function duplicateSection(sections: readonly Section[], id: string): { sections: Section[]; id: string } | null {
  const index = sections.findIndex((section) => section.id === id);
  const source = sections[index];
  if (!source || !canAddSectionType(sections, source.type)) return null;
  const copyId = newSectionId(source.type, sections);
  const next = [...sections];
  next.splice(index + 1, 0, { ...structuredClone(source), id: copyId } as Section);
  return { sections: next, id: copyId };
}

/** The list without a section, with what Undo needs to put it back. */
export function removeSection(sections: readonly Section[], id: string): { sections: Section[]; removed: Section; index: number } | null {
  const index = sections.findIndex((section) => section.id === id);
  if (index < 0) return null;
  return { sections: sections.filter((section) => section.id !== id), removed: sections[index]!, index };
}

/** A removed section back at its place (unless its id was reused, or its place taken, meanwhile). */
export function restoreSection(sections: readonly Section[], section: Section, index: number): Section[] {
  if (sections.some((each) => each.id === section.id) || !canAddSectionType(sections, section.type)) return [...sections];
  const next = [...sections];
  next.splice(Math.min(index, next.length), 0, section);
  return next;
}

// ─── What a saved change means for the preview ─────────────────────────────

export type PreviewChange =
  | { kind: "none" }
  /** Only these sections' settings changed: render them again in place. */
  | { kind: "sections"; ids: string[] }
  /** Order, sections, home mode, look, brand or blocks changed: load the page again. */
  | { kind: "reload" };

/** Most sections a change swaps in place before a reload is simpler. */
const SWAP_LIMIT = 4;

/**
 * What the preview of `page` does after a save: swap the page's sections
 * whose settings alone changed, or load the page again for anything else.
 */
export function previewChange(before: Theme, after: Theme, page: EditorPage = { kind: "home" }): PreviewChange {
  const beforeSections = pageSections(before, page);
  const afterSections = pageSections(after, page);
  if (JSON.stringify(before) === JSON.stringify(after)) return { kind: "none" };
  if (!beforeSections || !afterSections) return { kind: "reload" };
  if (JSON.stringify(withPageSections(before, page, [])) !== JSON.stringify(withPageSections(after, page, []))) return { kind: "reload" };
  const shape = (sections: readonly Section[]) => sections.map((section) => `${section.id}:${section.type}:${section.version}:${section.hidden ?? false}`).join(",");
  if (shape(beforeSections) !== shape(afterSections)) return { kind: "reload" };
  const ids = afterSections
    .filter((section, index) => JSON.stringify(section.settings) !== JSON.stringify(beforeSections[index]!.settings))
    .map((section) => section.id);
  if (ids.length === 0) return { kind: "none" };
  return ids.length > SWAP_LIMIT ? { kind: "reload" } : { kind: "sections", ids };
}
