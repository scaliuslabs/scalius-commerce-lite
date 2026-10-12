/**
 * The theme editor's messages between the dashboard and the storefront
 * preview it frames (docs: storefront-theme.md, "Editor"). Both sides check
 * the other's exact origin (the dashboard and storefront origins from
 * Platform settings) and the window the message came from before reading
 * one, then validate its shape here. Messages carry mark ids, paths, layout
 * boxes and the editor's unsaved theme values: never a preview token or
 * anything a buyer typed.
 *
 * The preview reports where each marked part is (`layout`), so the editor
 * draws hover and selection in its own overlay above the frame. The editor
 * sends unsaved edits: tokens apply at once, text patches in place, sections
 * move in the page, and `render` and `paint` ask the storefront's
 * preview-only routes to draw unsaved sections and theme settings.
 *
 * Every command after `connect` carries a `seq`; the preview answers `ack`
 * once it applied it (a render or paint: once it landed or failed). The
 * editor sends a command again until its ack arrives, so an edit sent while
 * the frame navigates or reloads is never lost.
 */

export const THEME_EDITOR_SOURCE = "scalius-theme-editor";
export const THEME_PREVIEW_SOURCE = "scalius-theme-preview";

/** Mark ids follow the section id rule. */
export const THEME_PREVIEW_MARK_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
/** Most marks one page reports (sections of one page plus the page's fixed parts). */
export const THEME_PREVIEW_MARKS_MAX = 96;
/** Largest unsaved document or section list one `render` or `paint` carries, in characters. */
export const THEME_PREVIEW_BODY_MAX = 600_000;
/** The preview-only routes the bridge posts unsaved state to (same origin as the page). */
export const THEME_PREVIEW_RENDER_PATH = "/theme-preview/render";
export const THEME_PREVIEW_PAINT_PATH = "/theme-preview/paint";
/** A theme token: a custom property name without its dashes, and a value with no CSS structure. */
export const THEME_PREVIEW_TOKEN_NAME = /^[a-z0-9-]{1,64}$/;
export const THEME_PREVIEW_TOKEN_VALUE = /^[^;{}<>\\]{0,240}$/;
const MAX_TOKENS = 96;
const MAX_TEXT = 8_000;

/** A part's box in the frame's viewport, in CSS pixels: start (left), top, width, height. */
export type ThemePreviewRect = readonly [number, number, number, number];

/** Keys the preview forwards to the editor while the frame has focus (its shortcuts). */
export const THEME_PREVIEW_FORWARDED_KEYS = ["z", "y", "s", "d", "h", "/", "\\", "Escape", "Delete", "Backspace"] as const;

/** Preview → dashboard. */
export type ThemePreviewMessage =
  /** The bridge loaded and waits for `connect`. */
  | { source: typeof THEME_PREVIEW_SOURCE; type: "hello"; path: string }
  /** After `connect` (and after a swap): the page's marks, in page order. */
  | { source: typeof THEME_PREVIEW_SOURCE; type: "ready"; path: string; marks: string[] }
  /** Where each shown mark is, the scroll position and the page height. */
  | { source: typeof THEME_PREVIEW_SOURCE; type: "layout"; rects: Record<string, ThemePreviewRect>; scrollY: number; height: number }
  | { source: typeof THEME_PREVIEW_SOURCE; type: "hover"; id: string | null }
  /** The merchant clicked a marked part with the inspector on. */
  | { source: typeof THEME_PREVIEW_SOURCE; type: "select"; id: string }
  /** A shortcut pressed while the frame had focus. */
  | { source: typeof THEME_PREVIEW_SOURCE; type: "key"; key: string; mod: boolean; shift: boolean; alt: boolean }
  /** A preview-only render failed: the editor shows the saved page instead. */
  | { source: typeof THEME_PREVIEW_SOURCE; type: "render-failed" }
  /** The preview session ended (expired or revoked): the dashboard opens a new one. */
  | { source: typeof THEME_PREVIEW_SOURCE; type: "expired" }
  /** A command was applied (`marks`: the page's marks after a render changed them). */
  | { source: typeof THEME_PREVIEW_SOURCE; type: "ack"; seq: number; marks?: string[]; status?: "stale" | "failed" };

/** Dashboard → preview. Every command but `connect` carries `seq` (see `ack`). */
export type ThemeEditorCommand =
  /** Start editing; `scrollY` restores the place a replaced frame showed. */
  | { source: typeof THEME_EDITOR_SOURCE; type: "connect"; inspector: boolean; scrollY: number | null }
  /** Inspector on: a click selects. Off: the page behaves as buyers see it. */
  | { source: typeof THEME_EDITOR_SOURCE; type: "inspector"; on: boolean }
  /** Bring a mark into view only when it is outside the view, to the nearest edge. */
  | { source: typeof THEME_EDITOR_SOURCE; type: "reveal"; id: string }
  /** Theme tokens as custom properties (`--name: value`), applied at once. */
  | { source: typeof THEME_EDITOR_SOURCE; type: "tokens"; vars: Record<string, string> }
  /** The whole unsaved document: the storefront paints tokens, fonts and card attributes from it. */
  | { source: typeof THEME_EDITOR_SOURCE; type: "paint"; theme: unknown }
  /** One text setting of a section changed: replace its text where the page shows it. */
  | { source: typeof THEME_EDITOR_SOURCE; type: "text"; id: string; from: string; to: string }
  /** A region's shown sections, in order: the others hide. */
  | { source: typeof THEME_EDITOR_SOURCE; type: "arrange"; region: string; order: string[] }
  /** Draw unsaved sections through the preview-only route (`after` places a new one). */
  | { source: typeof THEME_EDITOR_SOURCE; type: "render"; body: unknown; after: string | null };

export type ThemeEditorMessage =
  | Extract<ThemeEditorCommand, { type: "connect" }>
  | (Exclude<ThemeEditorCommand, { type: "connect" }> & { seq?: number; revision?: number });

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const markId = (value: unknown): value is string => typeof value === "string" && THEME_PREVIEW_MARK_PATTERN.test(value);
const path = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && value.length <= 512;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const seqOf = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const rect = (value: unknown): value is ThemePreviewRect =>
  Array.isArray(value) && value.length === 4 && value.every(finite) && (value[2] as number) >= 0 && (value[3] as number) >= 0;
const size = (value: unknown): boolean => {
  try {
    return JSON.stringify(value ?? null).length <= THEME_PREVIEW_BODY_MAX;
  } catch {
    return false;
  }
};

/** A preview message's data, or null when it is not one. */
export function readThemePreviewMessage(data: unknown): ThemePreviewMessage | null {
  const message = record(data);
  if (!message || message.source !== THEME_PREVIEW_SOURCE) return null;
  const source = THEME_PREVIEW_SOURCE;
  switch (message.type) {
    case "hello":
      return path(message.path) ? { source, type: "hello", path: message.path } : null;
    case "ready":
      return path(message.path) && Array.isArray(message.marks) && message.marks.length <= THEME_PREVIEW_MARKS_MAX && message.marks.every(markId)
        ? { source, type: "ready", path: message.path, marks: [...message.marks] }
        : null;
    case "layout": {
      const rects = record(message.rects);
      if (!rects || !finite(message.scrollY) || !finite(message.height)) return null;
      const entries = Object.entries(rects);
      if (entries.length > THEME_PREVIEW_MARKS_MAX || !entries.every(([id, box]) => markId(id) && rect(box))) return null;
      return { source, type: "layout", rects: Object.fromEntries(entries) as Record<string, ThemePreviewRect>, scrollY: message.scrollY, height: message.height };
    }
    case "hover":
      return message.id === null || markId(message.id) ? { source, type: "hover", id: message.id } : null;
    case "select":
      return markId(message.id) ? { source, type: "select", id: message.id } : null;
    case "key":
      return typeof message.key === "string" && (THEME_PREVIEW_FORWARDED_KEYS as readonly string[]).includes(message.key)
        && typeof message.mod === "boolean" && typeof message.shift === "boolean" && typeof message.alt === "boolean"
        ? { source, type: "key", key: message.key, mod: message.mod, shift: message.shift, alt: message.alt }
        : null;
    case "render-failed":
    case "expired":
      return { source, type: message.type };
    case "ack":
      if (!seqOf(message.seq)) return null;
      if (message.status !== undefined && message.status !== "stale" && message.status !== "failed") return null;
      if (message.marks !== undefined && (!Array.isArray(message.marks) || message.marks.length > THEME_PREVIEW_MARKS_MAX || !message.marks.every(markId))) return null;
      return { source, type: "ack", seq: message.seq,
        ...(message.marks === undefined ? {} : { marks: [...(message.marks as string[])] }),
        ...(message.status === undefined ? {} : { status: message.status }),
      };
    default:
      return null;
  }
}

/** An editor message's data, or null when it is not one. */
export function readThemeEditorMessage(data: unknown): ThemeEditorMessage | null {
  const message = record(data);
  if (!message || message.source !== THEME_EDITOR_SOURCE) return null;
  if (message.seq !== undefined && (!seqOf(message.seq) || message.type === "connect")) return null;
  if (message.revision !== undefined && (!seqOf(message.revision) || message.type === "connect")) return null;
  const command = readThemeEditorCommand(message);
  return command && command.type !== "connect" ? {
    ...command,
    ...(seqOf(message.seq) ? { seq: message.seq } : {}),
    ...(seqOf(message.revision) ? { revision: message.revision } : {}),
  } as ThemeEditorMessage : command;
}

function readThemeEditorCommand(message: Record<string, unknown>): ThemeEditorCommand | null {
  const source = THEME_EDITOR_SOURCE;
  switch (message.type) {
    case "connect":
      return typeof message.inspector === "boolean" && (message.scrollY === null || finite(message.scrollY))
        ? { source, type: "connect", inspector: message.inspector, scrollY: message.scrollY }
        : null;
    case "inspector":
      return typeof message.on === "boolean" ? { source, type: "inspector", on: message.on } : null;
    case "reveal":
      return markId(message.id) ? { source, type: "reveal", id: message.id } : null;
    case "tokens": {
      const vars = record(message.vars);
      if (!vars) return null;
      const entries = Object.entries(vars);
      if (entries.length > MAX_TOKENS || !entries.every(([name, value]) =>
        THEME_PREVIEW_TOKEN_NAME.test(name) && typeof value === "string" && THEME_PREVIEW_TOKEN_VALUE.test(value))) return null;
      return { source, type: "tokens", vars: Object.fromEntries(entries) as Record<string, string> };
    }
    case "paint":
      return record(message.theme) && size(message.theme) ? { source, type: "paint", theme: message.theme } : null;
    case "text":
      return markId(message.id) && typeof message.from === "string" && typeof message.to === "string"
        && message.from.length <= MAX_TEXT && message.to.length <= MAX_TEXT
        ? { source, type: "text", id: message.id, from: message.from, to: message.to }
        : null;
    case "arrange":
      return markId(message.region) && Array.isArray(message.order) && message.order.length <= THEME_PREVIEW_MARKS_MAX && message.order.every(markId)
        ? { source, type: "arrange", region: message.region, order: [...message.order] }
        : null;
    case "render":
      return record(message.body) && size(message.body) && (message.after === null || markId(message.after))
        ? { source, type: "render", body: message.body, after: message.after }
        : null;
    default:
      return null;
  }
}

/**
 * Preview marks for page parts that are not sections, so the editor selects
 * them from the preview like sections: every page's header, announcement bar
 * and footer; a product page's main area (gallery and buy box), each module
 * below it and its app blocks; a listing's results and its filters; a CMS
 * page's content and the cart. They follow the section id rule and no
 * section type is named like them.
 */
export const THEME_EDITOR_MARKS = {
  header: "header",
  announcement: "announcement",
  footer: "footer",
  productMain: "product-main",
  productApps: "product-apps",
  listing: "listing",
  listingFilters: "listing-filters",
  pageContent: "page-content",
  cart: "cart-main",
} as const;

/**
 * The section regions a page shows: `page` (the homepage's or a landing
 * page's sections), or a template's sections `before` and `after` its fixed
 * part.
 */
export const THEME_PREVIEW_REGIONS = ["page", "before", "after"] as const;
export type ThemePreviewRegion = (typeof THEME_PREVIEW_REGIONS)[number];

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
