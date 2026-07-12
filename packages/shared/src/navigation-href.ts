export type NavigationHrefParseResult =
  | { ok: true; href?: string; kind: "label" | "internal" | "external" }
  | { ok: false; reason: string };

const LEGACY_PAGE_PATH = /^\/pages\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?([?#].*)?$/;

function containsControlOrWhitespace(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127 || /\s/.test(character)) return true;
  }
  return false;
}

/**
 * Canonical navigation targets are either same-store paths/fragments/queries,
 * safe relative paths (normalized to a leading slash), or absolute HTTPS URLs.
 * Empty values and the legacy `#` placeholder mean a non-clickable label.
 */
export function parseNavigationHref(value: unknown): NavigationHrefParseResult {
  if (value == null) return { ok: true, kind: "label" };
  if (typeof value !== "string") {
    return { ok: false, reason: "Navigation URL must be text." };
  }

  const href = value.trim();
  if (!href || href === "#") return { ok: true, kind: "label" };
  if (href.length > 2_048) {
    return { ok: false, reason: "Navigation URL must be 2048 characters or fewer." };
  }
  if (containsControlOrWhitespace(href) || href.includes("\\")) {
    return { ok: false, reason: "Navigation URL cannot contain spaces, control characters, or backslashes." };
  }
  if (href.startsWith("//")) {
    return { ok: false, reason: "Protocol-relative navigation URLs are not allowed." };
  }

  if (href.startsWith("/")) {
    const legacyPage = LEGACY_PAGE_PATH.exec(href);
    return {
      ok: true,
      kind: "internal",
      href: legacyPage
        ? `/${legacyPage[1]}${legacyPage[2] ?? ""}`
        : href,
    };
  }
  if (href.startsWith("?") || href.startsWith("#")) {
    return { ok: true, kind: "internal", href };
  }

  try {
    const url = new URL(href);
    if (url.protocol !== "https:") {
      return { ok: false, reason: "External navigation URLs must use HTTPS." };
    }
    if (url.username || url.password) {
      return { ok: false, reason: "Navigation URLs cannot include credentials." };
    }
    return { ok: true, kind: "external", href: url.toString() };
  } catch {
    if (
      href.startsWith(".") ||
      href.includes("../") ||
      href.includes("./")
    ) {
      return { ok: false, reason: "Navigation URLs cannot traverse relative paths." };
    }
    return { ok: true, kind: "internal", href: `/${href}` };
  }
}

export function normalizeNavigationHref(value: unknown): string | undefined {
  const result = parseNavigationHref(value);
  return result.ok ? result.href : undefined;
}
