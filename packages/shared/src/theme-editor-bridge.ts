/**
 * The theme editor's messages between the dashboard and the storefront
 * preview it frames. Both sides check the other's exact origin (the
 * dashboard and storefront origins from Platform settings) and the window
 * the message came from before reading one, then validate its shape here.
 * Messages carry section ids and paths only: never a preview token, theme
 * content or anything a buyer typed.
 */

export const THEME_EDITOR_SOURCE = "scalius-theme-editor";
export const THEME_PREVIEW_SOURCE = "scalius-theme-preview";

/** Section ids follow the registry's id rule. */
const SECTION_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const MAX_SECTIONS = 24;

/** Preview → dashboard. */
export type ThemePreviewMessage =
  /** The bridge loaded and waits for `connect`. */
  | { source: typeof THEME_PREVIEW_SOURCE; type: "hello"; path: string }
  /** After `connect`: the page's marked sections, in page order. */
  | { source: typeof THEME_PREVIEW_SOURCE; type: "ready"; path: string; sections: string[] }
  /** The merchant clicked a section in the preview. */
  | { source: typeof THEME_PREVIEW_SOURCE; type: "select"; sectionId: string }
  /** The preview session ended (expired or revoked): the dashboard opens a new one. */
  | { source: typeof THEME_PREVIEW_SOURCE; type: "expired" };

/** Dashboard → preview. */
export type ThemeEditorMessage =
  /** Start editing: outlines on hover, clicks select. Names label the outlines. */
  | { source: typeof THEME_EDITOR_SOURCE; type: "connect"; names: Record<string, string>; selected: string | null }
  | { source: typeof THEME_EDITOR_SOURCE; type: "highlight"; sectionId: string | null }
  | { source: typeof THEME_EDITOR_SOURCE; type: "select"; sectionId: string | null }
  | { source: typeof THEME_EDITOR_SOURCE; type: "scroll-to"; sectionId: string }
  /** These sections' saved settings changed: render them again from the draft. */
  | { source: typeof THEME_EDITOR_SOURCE; type: "section-updated"; sectionIds: string[] }
  /** The page's structure or theme changed: load it again (keeping the scroll position). */
  | { source: typeof THEME_EDITOR_SOURCE; type: "reload" }
  /** Back to the homepage after the merchant followed a link in the preview. */
  | { source: typeof THEME_EDITOR_SOURCE; type: "go-home" };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const sectionId = (value: unknown): value is string => typeof value === "string" && SECTION_ID.test(value);
const path = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && value.length <= 512;

/** A preview message's data, or null when it is not one. */
export function readThemePreviewMessage(data: unknown): ThemePreviewMessage | null {
  const message = record(data);
  if (!message || message.source !== THEME_PREVIEW_SOURCE) return null;
  switch (message.type) {
    case "hello":
      return path(message.path) ? { source: THEME_PREVIEW_SOURCE, type: "hello", path: message.path } : null;
    case "ready":
      return path(message.path) && Array.isArray(message.sections) && message.sections.length <= MAX_SECTIONS * 2 && message.sections.every(sectionId)
        ? { source: THEME_PREVIEW_SOURCE, type: "ready", path: message.path, sections: [...message.sections] }
        : null;
    case "select":
      return sectionId(message.sectionId) ? { source: THEME_PREVIEW_SOURCE, type: "select", sectionId: message.sectionId } : null;
    case "expired":
      return { source: THEME_PREVIEW_SOURCE, type: "expired" };
    default:
      return null;
  }
}

/** An editor message's data, or null when it is not one. */
export function readThemeEditorMessage(data: unknown): ThemeEditorMessage | null {
  const message = record(data);
  if (!message || message.source !== THEME_EDITOR_SOURCE) return null;
  switch (message.type) {
    case "connect": {
      const names = record(message.names);
      if (!names || Object.keys(names).length > MAX_SECTIONS) return null;
      const entries = Object.entries(names);
      if (!entries.every(([id, name]) => sectionId(id) && typeof name === "string" && name.length <= 120)) return null;
      if (message.selected !== null && !sectionId(message.selected)) return null;
      return { source: THEME_EDITOR_SOURCE, type: "connect", names: Object.fromEntries(entries) as Record<string, string>, selected: message.selected };
    }
    case "highlight":
    case "select":
      return message.sectionId === null || sectionId(message.sectionId)
        ? { source: THEME_EDITOR_SOURCE, type: message.type, sectionId: message.sectionId }
        : null;
    case "scroll-to":
      return sectionId(message.sectionId) ? { source: THEME_EDITOR_SOURCE, type: "scroll-to", sectionId: message.sectionId } : null;
    case "section-updated":
      return Array.isArray(message.sectionIds) && message.sectionIds.length > 0 && message.sectionIds.length <= MAX_SECTIONS && message.sectionIds.every(sectionId)
        ? { source: THEME_EDITOR_SOURCE, type: "section-updated", sectionIds: [...message.sectionIds] }
        : null;
    case "reload":
    case "go-home":
      return { source: THEME_EDITOR_SOURCE, type: message.type };
    default:
      return null;
  }
}

/**
 * Preview marks for page parts that are not sections, so the editor selects
 * them from the preview like sections: a product page's main area (gallery
 * and buy box), each module below it and its app blocks; a listing's results
 * and its filters. They follow the section id rule.
 */
export const THEME_EDITOR_MARKS = {
  productMain: "product-main",
  productApps: "product-apps",
  listing: "listing",
  listingFilters: "listing-filters",
} as const;

/** The mark of one product page module (`module-reviews`). */
export function themeEditorModuleMark(module: string): string {
  return `module-${module}`;
}

/** An http(s) origin exactly as `URL.origin` writes it, or "" for anything else. */
export function themeEditorOrigin(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return "";
    return url.origin;
  } catch {
    return "";
  }
}

/**
 * Whether a received message may be read: it came from the expected window
 * and from exactly the expected origin (never "*" or a prefix match).
 */
export function isTrustedThemeEditorEvent(
  event: { origin: string; source: unknown },
  expected: { origin: string; source: unknown },
): boolean {
  return Boolean(expected.origin) && expected.source !== null && expected.source !== undefined
    && event.origin === expected.origin && event.source === expected.source;
}
