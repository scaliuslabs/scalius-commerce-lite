import { presenceOfPath, stripPresencePath } from "@scalius/shared/markets";
import { isThemePreviewablePath } from "@scalius/shared/theme-preview-path";
// Relative: the dashboard's editor tests import this file too.
import { isPrivateStorefrontPathname } from "./cache-policy";

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }
  return false;
}

/**
 * What the preview shows for a requested path: the public page itself (same
 * origin, with its harmless query), or why it can't. A buyer's own page is
 * refused by name, so the merchant is told rather than shown another page;
 * anything else that is not a public page (an endpoint, a discovery file,
 * another origin, the editor's own canvas) is "not-a-page". The preview
 * bearer is deliberately handled elsewhere and is never accepted as a query
 * parameter.
 */
export type ThemePreviewTarget =
  | { kind: "page"; path: string }
  | { kind: "buyer-page" }
  | { kind: "not-a-page" };

export function themePreviewTarget(value: unknown): ThemePreviewTarget {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return { kind: "page", path: "/" };
  if (
    raw.length > 512 ||
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    raw.includes("\\") ||
    hasControlCharacter(raw)
  ) {
    return { kind: "not-a-page" };
  }

  try {
    const parsed = new URL(raw, "https://theme-preview.invalid");
    if (parsed.origin !== "https://theme-preview.invalid" || parsed.hash) return { kind: "not-a-page" };
    if (isThemePreviewablePath(parsed.pathname)) return { kind: "page", path: `${parsed.pathname}${parsed.search}` };
    return isBuyerOwnPagePath(parsed.pathname) ? { kind: "buyer-page" } : { kind: "not-a-page" };
  } catch {
    return { kind: "not-a-page" };
  }
}

/**
 * A buyer's own page (`PRIVATE_STOREFRONT_ROOTS`: checkout, account,
 * receipts, tracking and the rest), at the root or under a market presence,
 * which no theme preview draws. The cart shell is a public page template and
 * the editor's canvas is the preview itself, so neither is one.
 */
export function isBuyerOwnPagePath(pathname: string): boolean {
  const presence = presenceOfPath(pathname);
  const page = presence ? stripPresencePath(pathname, presence) : pathname;
  return isPrivateStorefrontPathname(page) && !isThemePreviewablePath(page) && !/^\/theme-preview(?:\/|$)/.test(page);
}

/** The page a preview continuation lands on: the requested public page, else home. */
export function normalizeThemePreviewRoutePath(value: unknown): string {
  const target = themePreviewTarget(value);
  return target.kind === "page" ? target.path : "/";
}

export type ThemePreviewDevice = "full" | "desktop" | "mobile";

export function normalizeThemePreviewDevice(value: unknown): ThemePreviewDevice {
  return value === "desktop" || value === "mobile" ? value : "full";
}

/**
 * Keep the preview canvas addressable without touching its cookie-held bearer.
 * The returned URL preserves the selected storefront path and any harmless
 * route query while replacing only the bounded preview-device control.
 */
export function createThemePreviewDeviceUrl(
  currentUrl: string,
  device: unknown,
): string {
  const parsed = new URL(currentUrl);
  parsed.searchParams.set("device", normalizeThemePreviewDevice(device));
  return parsed.toString();
}

/**
 * Theme-preview tokens may be accepted only from the configured dashboard
 * origin. Never derive this authority from Referrer or a request parameter.
 */
export function normalizeThemePreviewDashboardOrigin(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const parsed = new URL(value.trim());
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password
    ) {
      return "";
    }
    return parsed.origin;
  } catch {
    return "";
  }
}
