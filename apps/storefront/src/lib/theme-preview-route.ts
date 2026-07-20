const PUBLIC_RESOURCE_PREFIXES = new Set([
  "products",
  "categories",
  "collections",
]);

const RESERVED_SINGLE_SEGMENT_PATHS = new Set([
  ".well-known",
  "404",
  "500",
  "account",
  "api",
  "buy",
  "cart",
  "checkout",
  "health",
  "order-success",
  "payment-recovery",
  "robots.txt",
  "search",
  "theme-preview",
  "ucp",
]);

function isSafePublicPath(pathname: string): boolean {
  if (pathname === "/" || pathname === "/search") return true;

  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 2 && PUBLIC_RESOURCE_PREFIXES.has(segments[0]!)) {
    return /^[A-Za-z0-9_-]+$/.test(segments[1]!);
  }

  if (segments.length !== 1 || !/^[A-Za-z0-9_-]+$/.test(segments[0]!)) {
    return false;
  }

  const segment = segments[0]!.toLowerCase();
  return !RESERVED_SINGLE_SEGMENT_PATHS.has(segment) && !segment.startsWith("sitemap");
}

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
 * Keep a theme preview on a buyer-visible, same-origin, read-only route.
 * The preview bearer is deliberately handled elsewhere and must never be
 * accepted as a query parameter here.
 */
export function normalizeThemePreviewRoutePath(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "/";
  if (
    raw.length > 512 ||
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    raw.includes("\\") ||
    hasControlCharacter(raw)
  ) {
    return "/";
  }

  try {
    const parsed = new URL(raw, "https://theme-preview.invalid");
    if (parsed.origin !== "https://theme-preview.invalid" || parsed.hash) {
      return "/";
    }
    if (!isSafePublicPath(parsed.pathname)) return "/";
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/";
  }
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
