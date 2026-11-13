import { hmacSha256Hex } from "@scalius/shared/hash";
import { deriveRuntimeSecret, readMasterSecret, type MasterSecretEnvironment } from "@scalius/shared/runtime-secrets";
import { isThemePreviewToken } from "@scalius/shared/theme-preview-token";

export const THEME_PREVIEW_COOKIE_NAME = "stp_theme_preview";
export const THEME_PREVIEW_COOKIE_MAX_AGE_SECONDS = 30 * 60;
/** HKDF label of the key that signs the preview cookie; derived where it is used, never installed. */
export const THEME_PREVIEW_COOKIE_PURPOSE = "storefront-theme-preview-cookie";

const SIGNATURE = /^[0-9a-f]{64}$/;
const EXPIRY = /^[1-9]\d{8,10}$/;

/**
 * The cookie's value is the preview bearer, when the cookie stops being a
 * preview (unix seconds) and the storefront's signature of both with the
 * store's origin (`<tpv_ token>.<expires>.<HMAC-SHA-256 hex>`). The API
 * alone says whether a bearer is live; the signature proves this storefront
 * set the cookie, for this store, and until when, so the gateway can tell a
 * merchant's preview from a forged, foreign or expired cookie without a call
 * (`verifyThemePreviewCookie`) and serve any of those the shared page.
 */
function readSignedValue(cookieHeader: string | null | undefined): { token: string; expiresAt: number; signature: string } | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValueParts] = part.trim().split("=");
    if (rawName !== THEME_PREVIEW_COOKIE_NAME) continue;
    try {
      const [token = "", expires = "", signature = "", ...rest] = decodeURIComponent(rawValueParts.join("=")).trim().split(".");
      return rest.length === 0 && isThemePreviewToken(token) && EXPIRY.test(expires) && SIGNATURE.test(signature)
        ? { token, expiresAt: Number(expires), signature }
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** The preview bearer of a well-formed cookie (its signature and expiry unchecked: the API decides), or "". */
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

function signPreview(key: string, origin: string, token: string, expiresAt: number): Promise<string> {
  return hmacSha256Hex(key, `stp-theme-preview\n${origin}\n${token}\n${expiresAt}`);
}

/**
 * Whether the request's preview cookie carries this storefront's signature
 * for this store (`origin`) and has not expired at `nowMs` (constant-time compare).
 */
export async function verifyThemePreviewCookie(
  cookieHeader: string | null | undefined,
  key: string | null,
  origin: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const value = readSignedValue(cookieHeader);
  if (!value || !key || value.expiresAt * 1000 <= nowMs) return false;
  const expected = await signPreview(key, origin, value.token, value.expiresAt);
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
  options: {
    /** The store's origin the cookie is for (the request's). */
    origin: string;
    embedded?: boolean;
    /** When the preview session ends (the API's answer); never later than the cookie's own lifetime. */
    sessionExpiresAt?: Date | null;
    nowMs?: number;
  },
): Promise<string> {
  const normalizedToken = token.trim();
  if (!isThemePreviewToken(normalizedToken) || !key) return "";
  const nowMs = options.nowMs ?? Date.now();
  const latest = Math.floor(nowMs / 1000) + THEME_PREVIEW_COOKIE_MAX_AGE_SECONDS;
  const session = options.sessionExpiresAt && Number.isFinite(options.sessionExpiresAt.getTime())
    ? Math.floor(options.sessionExpiresAt.getTime() / 1000)
    : latest;
  const expiresAt = Math.min(latest, session);
  if (expiresAt * 1000 <= nowMs) return "";
  return [
    `${THEME_PREVIEW_COOKIE_NAME}=${normalizedToken}.${expiresAt}.${await signPreview(key, options.origin, normalizedToken, expiresAt)}`,
    "Path=/",
    `Max-Age=${expiresAt - Math.floor(nowMs / 1000)}`,
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
