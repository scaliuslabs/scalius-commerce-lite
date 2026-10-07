/**
 * Keeps the preview in step with the working document without reloads or
 * waiting for autosave (research P11, P12): theme tokens at once as custom
 * properties (then painted by the preview-only paint route), a text setting
 * replaced in place while typing, sections moved and hidden in the page at
 * once, then drawn from the unsaved document by the preview-only render
 * route. What only a whole page can show (a header layout, the product
 * page's modules, a card style) is saved at once and the page loads again
 * in a hidden frame, swapped in when ready.
 */
import { useEffect, useRef } from "react";
import {
  buildStorefrontThemeTokens,
  isStorefrontThemeHexColor,
  storefrontScopeRegions,
  type StorefrontSection,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import { THEME_EDITOR_MARKS } from "@scalius/shared/theme-editor-bridge";
import { pageScope, pageSections, type EditorPage } from "./editor-pages";
import type { PreviewCommand } from "./use-preview";

type Theme = StorefrontThemeDocument;

const same = (left: unknown, right: unknown) => left === right || JSON.stringify(left) === JSON.stringify(right);

/** Typing settles this long before a section is drawn again. */
export const PREVIEW_RENDER_DELAY_MS = 250;

/** The string values that changed between two values (same shape), each with where it was. */
export function changedTexts(before: unknown, after: unknown, limit = 12): Array<{ from: string; to: string }> {
  const found: Array<{ from: string; to: string }> = [];
  const walk = (left: unknown, right: unknown) => {
    if (found.length >= limit || left === right) return;
    if (typeof left === "string" && typeof right === "string") {
      if (left.trim()) found.push({ from: left, to: right });
      return;
    }
    if (left && right && typeof left === "object" && typeof right === "object") {
      for (const key of Object.keys(right as object)) walk((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]);
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

/** What a change outside the page's sections and tokens needs: the page drawn again from the saved draft. */
function needsWholePage(before: Theme, after: Theme, page: EditorPage): boolean {
  return !same(before.blocks, after.blocks)
    || !same(before.brand, after.brand)
    || (page.kind === "home" && !same(before.pages.homeMode, after.pages.homeMode));
}

export function usePreviewSync({ send, reload, connectedAt, working, sendable, savedTheme, page, presence, onNeedSave }: {
  send: (command: PreviewCommand) => void;
  reload: () => void;
  /** Bumps each time a frame connects (it shows the saved draft then). */
  connectedAt: number;
  working: Theme;
  /** What can be saved now: every part valid (the render and paint routes accept only that). */
  sendable: Theme | null;
  savedTheme: Theme;
  page: EditorPage;
  presence: string | null;
  /** A change only a reload shows: save it now. */
  onNeedSave: () => void;
}) {
  /** What the preview shows now. */
  const shown = useRef<Theme | null>(null);
  const renderTimers = useRef(new Map<string, number>());
  const paintTimer = useRef(0);
  /** A change waits for its save, then the page loads again. */
  const reloadAfterSave = useRef(false);
  const latest = useRef({ sendable, page, presence });
  latest.current = { sendable, page, presence };

  // A frame that connects shows the saved draft.
  useEffect(() => {
    if (connectedAt > 0) shown.current = savedTheme;
  }, [connectedAt]); // eslint-disable-line react-hooks/exhaustive-deps -- the saved draft as of the connection

  const later = (key: string, delay: number, task: () => void) => {
    window.clearTimeout(renderTimers.current.get(key));
    renderTimers.current.set(key, window.setTimeout(() => {
      renderTimers.current.delete(key);
      task();
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
    if (!before || connectedAt === 0) return;
    if (before === working) return;
    shown.current = working;

    // Theme tokens: at once as custom properties, then painted (fonts, card attributes).
    if (!same(before.tokens, working.tokens)) {
      if (Object.values(working.tokens.colors).every((color) => isStorefrontThemeHexColor(color))) {
        send({ type: "tokens", vars: buildStorefrontThemeTokens(working) });
      }
      window.clearTimeout(paintTimer.current);
      paintTimer.current = window.setTimeout(() => {
        const document = latest.current.sendable;
        if (document && same(document.tokens, shown.current?.tokens)) send({ type: "paint", theme: document });
      }, 150);
    }

    // The page's sections: moved and hidden at once, then drawn from the unsaved document.
    const was = pageSections(before, page) ?? [];
    const now = pageSections(working, page) ?? [];
    const scope = pageScope(working, page);
    const mainMoved = scope?.kind === "template" && pageScope(before, page)?.kind === "template"
      && (pageScope(before, page) as { main: number }).main !== scope.main;
    if (!sameShape(was, now) || mainMoved) {
      if (scope) {
        for (const region of storefrontScopeRegions({ ...working.pages }, scope)) {
          send({ type: "arrange", region: region.region, order: region.sections.filter((section) => !section.hidden).map((section) => section.id) });
        }
      }
      later("regions", PREVIEW_RENDER_DELAY_MS, () => {
        const body = renderBody({});
        if (body) send({ type: "render", body, after: null });
      });
    } else {
      for (const section of now) {
        const old = was.find((each) => each.id === section.id);
        if (!old || same(old.settings, section.settings)) continue;
        for (const text of changedTexts(old.settings, section.settings)) send({ type: "text", id: section.id, ...text });
        later(section.id, PREVIEW_RENDER_DELAY_MS, () => {
          // Only a section that is valid now is drawn again; a field with an error keeps its own text in the page.
          const document = latest.current.sendable;
          const valid = document && pageSections(document, latest.current.page)?.find((each) => each.id === section.id);
          if (!valid || !same(valid.settings, section.settings)) return;
          const body = renderBody({ only: section.id });
          if (body) send({ type: "render", body, after: null });
        });
      }
    }

    // Shared words show while typing; anything else outside the sections needs the page again, saved.
    if (!same(before.blocks.topBar, working.blocks.topBar)) {
      for (const text of changedTexts(before.blocks.topBar.settings, working.blocks.topBar.settings)) send({ type: "text", id: THEME_EDITOR_MARKS.announcement, ...text });
    }
    if (!same(before.blocks.footer, working.blocks.footer)) {
      for (const text of changedTexts(before.blocks.footer.settings, working.blocks.footer.settings)) send({ type: "text", id: THEME_EDITOR_MARKS.footer, ...text });
    }
    if (needsWholePage(before, working, page)) {
      reloadAfterSave.current = true;
      onNeedSave();
    }
  }, [working, connectedAt]); // eslint-disable-line react-hooks/exhaustive-deps -- runs per edit; the rest is read through refs

  // The saved draft caught up with a change only a whole page shows: load it again (in a hidden frame).
  useEffect(() => {
    if (!reloadAfterSave.current) return;
    if (!sendable || !same(sendable.blocks, savedTheme.blocks) || !same(sendable.brand, savedTheme.brand)) return;
    reloadAfterSave.current = false;
    reload();
  }, [savedTheme]); // eslint-disable-line react-hooks/exhaustive-deps -- once per save

  useEffect(() => () => {
    window.clearTimeout(paintTimer.current);
    for (const timer of renderTimers.current.values()) window.clearTimeout(timer);
  }, []);
}
