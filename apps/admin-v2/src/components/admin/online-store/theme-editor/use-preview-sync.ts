/**
 * Keeps the preview in step with the working document without reloads or
 * waiting for autosave (research P11, P12): theme tokens at once as custom
 * properties (then painted by the preview-only paint route) in the colour
 * set the Colours group edits (the canvas shows that set), a text setting
 * replaced in place while typing, sections moved and hidden in the page at
 * once, then drawn from the unsaved document by the preview-only render
 * route. What only a whole page can show (a header layout, the product
 * page's modules, a card style, an app filling the header, footer or card)
 * is saved at once and the page loads again in a hidden frame, swapped in
 * when ready.
 */
import { useEffect, useRef } from "react";
import {
  buildStorefrontThemeTokens,
  isStorefrontThemeHexColor,
  storefrontScopeRegions,
  storefrontThemeShowsDarkColors,
  type StorefrontSection,
  type StorefrontThemeColorSet,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import { canvasTextField } from "./canvas-text";
import type { AppSectionEntry } from "./editor-state";
import { pageScope, pageSections, type EditorPage } from "./editor-pages";
import type { PreviewCommand } from "./use-preview";
import { sameFormValue } from "~/lib/form-values";

type Theme = StorefrontThemeDocument;

/** Edits settle this long before a section is drawn again (typed words show at once by the `text` patch). */
export const PREVIEW_RENDER_DELAY_MS = 90;

/** The string values that changed between two values (same shape), each with where it was. */
export function changedTexts(before: unknown, after: unknown, limit = 12): Array<{ field: string; from: string; to: string }> {
  const found: Array<{ field: string; from: string; to: string }> = [];
  const walk = (left: unknown, right: unknown, field = "") => {
    if (found.length >= limit || left === right) return;
    if (typeof left === "string" && typeof right === "string") {
      found.push({ field, from: left, to: right });
      return;
    }
    if (left && right && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right)) {
      for (const key of Object.keys(right as object)) walk((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], field ? `${field}.${key}` : key);
    }
  };
  walk(before, after);
  return found;
}

/** Whether two lists show the same sections in the same order (ids, types, hidden). */
function sameShape(left: readonly StorefrontSection[], right: readonly StorefrontSection[]): boolean {
  return left.length === right.length && left.every((section, index) => {
    const other = right[index]!;
    return section.id === other.id && section.type === other.type && (section.hidden ?? false) === (other.hidden ?? false);
  });
}

/**
 * The document as the canvas shows it: the colour set the Colours group
 * edits stands as the scheme (light or dark), so the paint and the instant
 * tokens show that set whatever the store's scheme is.
 */
export function previewColorDocument(theme: Theme, set: StorefrontThemeColorSet): Theme {
  const dark = set === "darkColors" && storefrontThemeShowsDarkColors(theme.tokens) && theme.tokens.darkColors !== null;
  const colorScheme = dark ? "dark" : "light";
  if (theme.tokens.colorScheme === colorScheme) return theme;
  return { ...theme, tokens: { ...theme.tokens, colorScheme } };
}

/** The tokens the canvas takes at once: those of the set it shows. */
function instantTokens(theme: Theme): Record<string, string> | null {
  const colors = theme.tokens.colorScheme === "dark" ? theme.tokens.darkColors : theme.tokens.colors;
  if (!colors || !Object.values(colors).every((color) => isStorefrontThemeHexColor(color))) return null;
  return buildStorefrontThemeTokens({ tokens: { ...theme.tokens, colors } });
}

/** What a change outside the page's sections and tokens needs: the page drawn again from the saved draft. */
function needsWholePage(before: Theme, after: Theme, page: EditorPage): boolean {
  // The core header draws the shoppers' colour switch.
  return before.tokens.colorSchemeToggle !== after.tokens.colorSchemeToggle
    || !sameFormValue(before.blocks, after.blocks)
    || !sameFormValue(before.brand, after.brand)
    || !sameFormValue(before.apps, after.apps)
    || (page.kind === "home" && !sameFormValue(before.pages.homeMode, after.pages.homeMode));
}

/** A changed text's canvas field: the setting path, or an app section's setting key (`values.<key>`). */
function textFieldOf(section: StorefrontSection, path: string): string | null {
  if (section.type !== "app") return path;
  const key = path.startsWith("values.") ? path.slice("values.".length) : "";
  return key && !key.includes(".") ? key : null;
}

export function usePreviewSync({ send, reload, connectedAt, working, sendable, savedTheme, page, presence, marks, appSections, onNeedSave, enabled = true, fieldsEnabled = false, resyncAt = 0, colorSet = "colors" }: {
  send: (command: PreviewCommand) => void;
  /** Historical frames must never receive optimistic working-document edits. */
  enabled?: boolean;
  /** Optional capability from the active bridge; older previews use canonical renders only. */
  fieldsEnabled?: boolean;
  /** A stale response needs the latest complete document once, after edits settle. */
  resyncAt?: number;
  reload: () => void;
  /** Bumps each time a frame connects (it shows the saved draft then). */
  connectedAt: number;
  working: Theme;
  /** What can be saved now: every part valid (the render and paint routes accept only that). */
  sendable: Theme | null;
  savedTheme: Theme;
  page: EditorPage;
  presence: string | null;
  /** The marks the shown page has (a moved or shown section already drawn needs no render). */
  marks: readonly string[];
  /** The active apps' sections: which of an app section's settings are its canvas text. */
  appSections?: ReadonlyMap<string, AppSectionEntry>;
  /** A change only a reload shows: save it now. */
  onNeedSave: () => void;
  /** The colour set the canvas shows (the one the Colours group edits). */
  colorSet?: StorefrontThemeColorSet;
}) {
  /** What the preview shows now. */
  const shown = useRef<Theme | null>(null);
  const revision = useRef(0);
  const reconciled = useRef(0);
  const renderTimers = useRef(new Map<string, number>());
  const paintTimer = useRef(0);
  /** A change waits for its save, then the page loads again. */
  const reloadAfterSave = useRef(false);
  const latest = useRef({ sendable, page, presence, marks, enabled, colorSet });
  latest.current = { sendable, page, presence, marks, enabled, colorSet };
  /** What the paint route paints: the sendable document in the colour set the canvas shows. */
  const paintable = () => {
    const document = latest.current.sendable;
    return document ? previewColorDocument(document, latest.current.colorSet) : null;
  };
  const emit = (command: PreviewCommand) => {
    if (latest.current.enabled) send({ ...command, revision: Math.max(1, revision.current) });
  };

  // A frame that connects shows the saved draft.
  useEffect(() => {
    shown.current = enabled && connectedAt > 0 ? savedTheme : null;
    if (!enabled) reloadAfterSave.current = false;
  }, [connectedAt, enabled]); // eslint-disable-line react-hooks/exhaustive-deps -- the saved draft as of the connection

  const later = (key: string, delay: number, task: () => void) => {
    window.clearTimeout(renderTimers.current.get(key));
    renderTimers.current.set(key, window.setTimeout(() => {
      renderTimers.current.delete(key);
      if (latest.current.enabled) task();
    }, delay));
  };

  const renderBody = (extra: Record<string, unknown>) => {
    const { sendable: document, page: current, presence: market } = latest.current;
    if (!document) return null;
    const scope = pageScope(document, current);
    const sections = pageSections(document, current);
    if (!scope || !sections) return null;
    return { scope, sections, ...(market ? { presence: market } : {}), ...extra };
  };

  useEffect(() => {
    const before = shown.current;
    if (!enabled || !before || connectedAt === 0) return;
    if (before === working) return;
    shown.current = working;
    revision.current += 1;

    // Theme tokens: at once as custom properties, then painted (fonts, card attributes).
    if (!sameFormValue(before.tokens, working.tokens)) {
      const vars = instantTokens(previewColorDocument(working, colorSet));
      if (vars) emit({ type: "tokens", vars });
      window.clearTimeout(paintTimer.current);
      paintTimer.current = window.setTimeout(() => {
        const document = latest.current.sendable;
        if (document && sameFormValue(document.tokens, shown.current?.tokens)) emit({ type: "paint", theme: paintable()! });
      }, PREVIEW_RENDER_DELAY_MS);
    }

    // The page's sections: moved and hidden at once, then drawn from the unsaved document.
    const was = pageSections(before, page) ?? [];
    const now = pageSections(working, page) ?? [];
    const scope = pageScope(working, page);
    const mainMoved = scope?.kind === "template" && pageScope(before, page)?.kind === "template"
      && (pageScope(before, page) as { main: number }).main !== scope.main;
    const shapeChanged = !sameShape(was, now) || mainMoved;
    const grouped = (section: StorefrontSection) => section.type === "banner" && section.settings.layout !== "full";
    const settingsChanged = now.filter((section) => {
      const old = was.find((each) => each.id === section.id);
      return !section.hidden && old && !sameFormValue(old.settings, section.settings);
    });
    // Grouped banners are one render unit. DOM moves cannot edit one sibling.
    const groupChanged = (shapeChanged && [...was, ...now].some(grouped))
      || settingsChanged.some((section) => grouped(section) || was.some((old) => old.id === section.id && grouped(old)));
    const drawn = new Set(latest.current.marks);
    // Hero placement follows category tiles. Other units keep their phone slot
    // through replacements without rereading unrelated sibling dependencies.
    const phoneOrdered = [...was, ...now].some((section) => !section.hidden && section.type === "hero" && section.settings.phonePlacement === "after-categories");
    const phonePlacementChanged = settingsChanged.some((section) => section.type === "hero" || section.type === "category_tiles");
    let regionsNeeded = groupChanged || mainMoved || (phoneOrdered && (shapeChanged || phonePlacementChanged));
    if (shapeChanged && scope && !groupChanged) {
      for (const region of storefrontScopeRegions({ ...working.pages }, scope)) {
        const order = region.sections.filter((section) => !section.hidden).map((section) => section.id);
        emit({ type: "arrange", region: region.region, order });
        if (!order.every((id) => drawn.has(id))) regionsNeeded = true;
      }
    }
    // Reorder and settings can change in the same history step: handle both.
    for (const section of settingsChanged) {
      const old = was.find((each) => each.id === section.id)!;
      if (fieldsEnabled) for (const text of changedTexts(old.settings, section.settings)) {
        const name = textFieldOf(section, text.field);
        const field = name === null ? null : canvasTextField(section, name, appSections);
        // Removing/defaulting text, paragraph bodies and unknown fields require the renderer.
        if (field?.patch && text.from.trim() && text.to.trim()) emit({ type: "text", id: section.id, field: field.field, value: text.to.trim() });
      }
      // Empty-to-visible has no reliable DOM anchor (several may appear together).
      // A canonical region render preserves page/before/after and document order.
      if (!drawn.has(section.id)) regionsNeeded = true;
    }
    if (regionsNeeded) {
      for (const timer of renderTimers.current.values()) window.clearTimeout(timer);
      renderTimers.current.clear();
      later("regions", PREVIEW_RENDER_DELAY_MS, () => {
        const body = renderBody({});
        if (body) emit({ type: "render", body, after: null });
      });
    } else {
      for (const section of settingsChanged) {
        later(section.id, PREVIEW_RENDER_DELAY_MS, () => {
          const document = latest.current.sendable;
          if (!document) return;
          const valid = pageSections(document, latest.current.page)?.find((each) => each.id === section.id);
          if (!valid || !sameFormValue(valid.settings, section.settings)) return;
          const currentScope = pageScope(document, latest.current.page);
          const region = currentScope && storefrontScopeRegions(document.pages, currentScope)
            .find((each) => each.sections.some((item) => item.id === section.id));
          if (!region) return;
          const preceding = region.sections.slice(0, region.sections.findIndex((each) => each.id === section.id));
          const after = preceding.filter((each) => !each.hidden && latest.current.marks.includes(each.id)).at(-1)?.id ?? null;
          const body = renderBody({ only: section.id, region: region.region });
          if (body) emit({ type: "render", body, after });
        });
      }
    }

    // Unmarked/shared copy uses the existing saved-page refresh, never word matching.
    if (needsWholePage(before, working, page)) {
      reloadAfterSave.current = true;
      onNeedSave();
    }
  }, [working, connectedAt, enabled]); // eslint-disable-line react-hooks/exhaustive-deps -- runs per edit; the rest is read through refs

  // A discarded cross-kind response may contain an edit another unit did not.
  // Reconcile one latest snapshot; no stale-response loop between sibling units.
  useEffect(() => {
    if (!enabled || !sendable || connectedAt === 0 || resyncAt <= reconciled.current) return;
    later("reconcile", PREVIEW_RENDER_DELAY_MS, () => {
      const document = latest.current.sendable;
      const body = renderBody({});
      if (!document || !body) return;
      reconciled.current = resyncAt;
      emit({ type: "render", body, after: null });
      emit({ type: "paint", theme: paintable()! });
    });
  }, [resyncAt, sendable, enabled, connectedAt]); // eslint-disable-line react-hooks/exhaustive-deps -- latest snapshot at dispatch

  // The canvas shows the colour set the Colours group edits: painted again when it changes, and on a new frame.
  const paintedSet = useRef(colorSet);
  useEffect(() => {
    if (!enabled || connectedAt === 0) return;
    const saved = latest.current.sendable;
    if (!saved) return;
    const document = previewColorDocument(saved, colorSet);
    const switched = paintedSet.current !== colorSet;
    paintedSet.current = colorSet;
    // A new frame shows the saved draft as stored: paint only when the canvas shows another set.
    if (!switched && document === saved) return;
    revision.current += 1;
    const vars = instantTokens(document);
    if (vars) emit({ type: "tokens", vars });
    emit({ type: "paint", theme: document });
  }, [colorSet, connectedAt, enabled]); // eslint-disable-line react-hooks/exhaustive-deps -- the latest document through refs

  // The saved draft caught up with a change only a whole page shows: load it again (in a hidden frame).
  useEffect(() => {
    if (!enabled || !reloadAfterSave.current) return;
    if (!sendable || !sameFormValue(sendable.blocks, savedTheme.blocks) || !sameFormValue(sendable.brand, savedTheme.brand) || !sameFormValue(sendable.apps, savedTheme.apps)) return;
    reloadAfterSave.current = false;
    reload();
  }, [savedTheme]); // eslint-disable-line react-hooks/exhaustive-deps -- once per save

  useEffect(() => () => {
    window.clearTimeout(paintTimer.current);
    for (const timer of renderTimers.current.values()) window.clearTimeout(timer);
    renderTimers.current.clear();
  }, [enabled, page, presence]);
}
