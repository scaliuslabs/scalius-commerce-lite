import { isThemePreviewToken } from "@scalius/shared/theme-preview-token";

export const THEME_PREVIEW_COOKIE_NAME = "stp_theme_preview";
export const THEME_PREVIEW_COOKIE_MAX_AGE_SECONDS = 30 * 60;

export function readThemePreviewCookie(
  cookieHeader: string | null | undefined,
): string {
  if (!cookieHeader) return "";
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValueParts] = part.trim().split("=");
    if (rawName !== THEME_PREVIEW_COOKIE_NAME) continue;
    try {
      const value = decodeURIComponent(rawValueParts.join("=")).trim();
      return isThemePreviewToken(value) ? value : "";
    } catch {
      return "";
    }
  }
  return "";
}

export function createThemePreviewCookieHeader(token: string): string {
  const normalizedToken = token.trim();
  if (!isThemePreviewToken(normalizedToken)) return "";
  return [
    `${THEME_PREVIEW_COOKIE_NAME}=${encodeURIComponent(normalizedToken)}`,
    "Path=/",
    `Max-Age=${THEME_PREVIEW_COOKIE_MAX_AGE_SECONDS}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

export function clearThemePreviewCookieHeader(): string {
  return [
    `${THEME_PREVIEW_COOKIE_NAME}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}
