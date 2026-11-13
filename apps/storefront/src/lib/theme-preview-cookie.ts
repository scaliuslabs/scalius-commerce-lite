import { hmacSha256Hex } from "@scalius/shared/hash";
import { deriveRuntimeSecret, readMasterSecret, type MasterSecretEnvironment } from "@scalius/shared/runtime-secrets";
import { isThemePreviewToken } from "@scalius/shared/theme-preview-token";

export const THEME_PREVIEW_COOKIE_NAME = "stp_theme_preview";
export const THEME_PREVIEW_COOKIE_MAX_AGE_SECONDS = 30 * 60;
/** HKDF label of the key that signs the preview cookie; derived where it is used, never installed. */
export const THEME_PREVIEW_COOKIE_PURPOSE = "storefront-theme-preview-cookie";

const SIGNATURE = /^[0-9a-f]{64}$/;

/**
 * The cookie's value is the preview bearer and the storefront's signature of
 * it (`<tpv_ token>.<HMAC-SHA-256 hex>`). The API alone says whether a bearer
 * is live; the signature only proves this storefront set the cookie, so the
 * gateway can tell a merchant's preview from a forged cookie without a call
 * (`verifyThemePreviewCookie`) and serve the forgery the shared anonymous page.
 */
function readSignedValue(cookieHeader: string | null | undefined): { token: string; signature: string } | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValueParts] = part.trim().split("=");
    if (rawName !== THEME_PREVIEW_COOKIE_NAME) continue;
    try {
      const [token = "", signature = "", ...rest] = decodeURIComponent(rawValueParts.join("=")).trim().split(".");
      return rest.length === 0 && isThemePreviewToken(token) && SIGNATURE.test(signature) ? { token, signature } : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** The preview bearer of a well-formed cookie (its signature unchecked: the API decides), or "". */
export function readThemePreviewCookie(
  cookieHeader: string | null | undefined,
): string {
  return readSignedValue(cookieHeader)?.token ?? "";
}

/** The key that signs preview cookies, or null without the master secret (no cookie is then set or trusted). */
export async function themePreviewCookieKey(env: MasterSecretEnvironment | null | undefined): Promise<string | null> {
  const master = readMasterSecret(env);
  return master ? deriveRuntimeSecret(master, THEME_PREVIEW_COOKIE_PURPOSE) : null;
}

function signPreviewToken(key: string, token: string): Promise<string> {
  return hmacSha256Hex(key, `stp-theme-preview\n${token}`);
}

/** Whether the request's preview cookie carries this storefront's signature (constant-time compare). */
export async function verifyThemePreviewCookie(cookieHeader: string | null | undefined, key: string | null): Promise<boolean> {
  const value = readSignedValue(cookieHeader);
  if (!value || !key) return false;
  const expected = await signPreviewToken(key, value.token);
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ value.signature.charCodeAt(index);
  return difference === 0;
}

/**
 * The preview cookie. A tab's is first-party (SameSite=Lax). The theme
 * editor's frame is the storefront inside the dashboard, often another site,
 * where a Lax cookie is neither set nor sent: its cookie is SameSite=None
 * and Partitioned (CHIPS), so it exists only under the dashboard's top-level
 * site and no other site that frames the storefront can use it.
 */
export async function createThemePreviewCookieHeader(
  token: string,
  key: string | null,
  options: { embedded?: boolean } = {},
): Promise<string> {
  const normalizedToken = token.trim();
  if (!isThemePreviewToken(normalizedToken) || !key) return "";
  return [
    `${THEME_PREVIEW_COOKIE_NAME}=${normalizedToken}.${await signPreviewToken(key, normalizedToken)}`,
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
