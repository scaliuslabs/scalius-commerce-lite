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

/**
 * The preview cookie. A tab's is first-party (SameSite=Lax). The theme
 * editor's frame is the storefront inside the dashboard, often another site,
 * where a Lax cookie is neither set nor sent: its cookie is SameSite=None
 * and Partitioned (CHIPS), so it exists only under the dashboard's top-level
 * site and no other site that frames the storefront can use it.
 */
export function createThemePreviewCookieHeader(token: string, options: { embedded?: boolean } = {}): string {
  const normalizedToken = token.trim();
  if (!isThemePreviewToken(normalizedToken)) return "";
  return [
    `${THEME_PREVIEW_COOKIE_NAME}=${encodeURIComponent(normalizedToken)}`,
    "Path=/",
    `Max-Age=${THEME_PREVIEW_COOKIE_MAX_AGE_SECONDS}`,
    "HttpOnly",
    "Secure",
    ...(options.embedded ? ["SameSite=None", "Partitioned"] : ["SameSite=Lax"]),
  ].join("; ");
}

/**
 * Clears the preview cookie in both of its scopes. The tab cookie (Lax) and
 * the editor frame's cookie (SameSite=None; Partitioned) are different
 * cookies to a browser: where the dashboard and the storefront share a site
 * (localhost, or one registrable domain) the frame's partitioned cookie is
 * also sent to a top-level storefront tab, and a delete that names only the
 * Lax scope leaves it behind, so the preview never ends.
 */
export function clearThemePreviewCookieHeaders(): string[] {
  const expired = `${THEME_PREVIEW_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure`;
  return [`${expired}; SameSite=Lax`, `${expired}; SameSite=None; Partitioned`];
}

export function appendClearThemePreviewCookies(headers: Headers): void {
  for (const header of clearThemePreviewCookieHeaders()) headers.append("Set-Cookie", header);
}
