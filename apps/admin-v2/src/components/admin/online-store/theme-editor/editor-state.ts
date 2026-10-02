/**
 * The theme editor's client state: the draft with undo and redo history,
 * homepage section operations, and what a saved change means for the
 * preview (swap the changed sections, or load the page again).
 */
import {
  STOREFRONT_MAX_SECTIONS,
  storefrontSectionDefault,
  type StorefrontSection,
  type StorefrontSectionType,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import { newSectionId } from "../SectionSettings";
import { rebaseDraft } from "../shared";

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

// ─── Homepage sections ─────────────────────────────────────────────────────

export function withSections(theme: Theme, home: Section[]): Theme {
  return { ...theme, pages: { ...theme.pages, home } };
}

/** The list with one section moved from one place to another. */
export function moveSectionTo(sections: readonly Section[], from: number, to: number): Section[] {
  if (from === to || from < 0 || to < 0 || from >= sections.length || to >= sections.length) return [...sections];
  const next = [...sections];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/** Only one hero leads a page: a store adds or copies it once. */
export function canAddSectionType(sections: readonly Section[], type: StorefrontSectionType): boolean {
  return sections.length < STOREFRONT_MAX_SECTIONS && (type !== "hero" || !sections.some((section) => section.type === "hero"));
}

/** A new section of a type at its defaults, after `afterIndex` (or last). */
export function addSection(sections: readonly Section[], type: StorefrontSectionType, afterIndex = sections.length - 1): { sections: Section[]; id: string } {
  const id = newSectionId(type, sections);
  const next = [...sections];
  next.splice(afterIndex + 1, 0, storefrontSectionDefault(type, id) as Section);
  return { sections: next, id };
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

/** A removed section back at its place (unless its id was reused meanwhile). */
export function restoreSection(sections: readonly Section[], section: Section, index: number): Section[] {
  if (sections.some((each) => each.id === section.id) || sections.length >= STOREFRONT_MAX_SECTIONS) return [...sections];
  const next = [...sections];
  next.splice(Math.min(index, next.length), 0, section);
  return next;
}

/**
 * The merchant's edits on top of a newer saved draft (another session's
 * save): every field they changed keeps their value, the rest take the
 * newer one, and homepage sections merge by id rather than as one list, so
 * two people editing different sections both keep their work. The order is
 * the merchant's when they reordered, the newer draft's otherwise.
 */
export function mergeDrafts(mine: Theme, base: Theme, theirs: Theme): Theme {
  const merged = rebaseDraft(
    { ...mine, pages: { ...mine.pages, home: [] } },
    { ...base, pages: { ...base.pages, home: [] } },
    { ...theirs, pages: { ...theirs.pages, home: [] } },
  );
  const order = (sections: readonly Section[]) => sections.map((section) => section.id).join(",");
  const baseById = new Map(base.pages.home.map((section) => [section.id, section]));
  const theirsById = new Map(theirs.pages.home.map((section) => [section.id, section]));
  const mineById = new Map(mine.pages.home.map((section) => [section.id, section]));
  const pick = (id: string): Section | null => {
    const own = mineById.get(id);
    const before = baseById.get(id);
    const newer = theirsById.get(id);
    if (!own) return before ? null : newer ?? null; // removed here, or added there
    if (!newer) return before ? null : own; // removed there, or added here
    if (!before) return own;
    return rebaseDraft(own, before, newer);
  };
  // Reordered here: the sections both drafts started with are in another order.
  const reordered = order(mine.pages.home.filter((section) => baseById.has(section.id)))
    !== order(base.pages.home.filter((section) => mineById.has(section.id)));
  const ids = !reordered
    ? [...theirs.pages.home.map((section) => section.id), ...mine.pages.home.filter((section) => !baseById.has(section.id)).map((section) => section.id)]
    : [...mine.pages.home.map((section) => section.id), ...theirs.pages.home.filter((section) => !baseById.has(section.id) && !mineById.has(section.id)).map((section) => section.id)];
  const home = [...new Set(ids)].map(pick).filter((section): section is Section => section !== null);
  return { ...merged, pages: { ...merged.pages, home: home.slice(0, STOREFRONT_MAX_SECTIONS) } };
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

export function previewChange(before: Theme, after: Theme): PreviewChange {
  const { pages: beforePages, ...beforeRest } = before;
  const { pages: afterPages, ...afterRest } = after;
  if (JSON.stringify(beforeRest) !== JSON.stringify(afterRest)) return { kind: "reload" };
  if (JSON.stringify(beforePages.homeMode) !== JSON.stringify(afterPages.homeMode)) return { kind: "reload" };
  const shape = (pages: Theme["pages"]) => pages.home.map((section) => `${section.id}:${section.type}:${section.version}`).join(",");
  if (shape(beforePages) !== shape(afterPages)) return { kind: "reload" };
  const ids = afterPages.home
    .filter((section, index) => JSON.stringify(section.settings) !== JSON.stringify(beforePages.home[index]!.settings))
    .map((section) => section.id);
  if (ids.length === 0) return { kind: "none" };
  return ids.length > SWAP_LIMIT ? { kind: "reload" } : { kind: "sections", ids };
}
