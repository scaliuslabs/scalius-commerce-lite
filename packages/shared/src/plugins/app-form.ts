// The platform's form token for app pages (docs/platform/PLUGINS.md,
// "Storefront proxy"): what makes a signed-in buyer's form post to an app's
// proxy (`/apps/<plugin id>/...`) provably come from this store's own page.
//
// - Issued by the storefront gateway into every `<form method="post">` whose
//   action is an app proxy path, on pages rendered for a signed-in buyer
//   (only those carry a session, and they are never served from the shared
//   page cache). It is a hidden field, so plain HTML forms work without
//   JavaScript, and the forms enhancer sends it with the other fields.
// - Verified by the API before the app's handler runs: an unsafe proxied
//   request that carries the store's session in a form encoding a cross-site
//   page could send (urlencoded, multipart, text/plain or none) is refused
//   without a valid token. JSON requests need no token: a cross-site page
//   cannot send them without a CORS preflight the store never grants, and the
//   proxy forwards the session for unsafe methods only from same-origin
//   pages. The field is removed before the app sees the body.
//
// The token is an HMAC of the plugin id and the buyer's session token under
// a key derived from SCALIUS_SECRET: a different app, session or store gets a
// different token, and it never names the session. It lives in a form body
// only, never a URL (GET forms never get one).

import { hmacSha256Hex } from "../hash";

/** The hidden field the platform adds to an app's POST forms. */
export const APP_FORM_TOKEN_FIELD = "_scalius_form";
/** HKDF purpose of the key both Workers derive from SCALIUS_SECRET. */
export const APP_FORM_TOKEN_PURPOSE = "app-form-token";
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/** The token of one app's forms for one buyer session. */
export function appFormToken(key: string, pluginId: string, sessionToken: string): Promise<string> {
  return hmacSha256Hex(key, `scalius-app-form\n${pluginId}\n${sessionToken}`);
}

/** Whether `token` is this app's token for the session (constant-time compare). */
export async function verifyAppFormToken(key: string, pluginId: string, sessionToken: string, token: unknown): Promise<boolean> {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return false;
  const expected = await appFormToken(key, pluginId, sessionToken);
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ token.charCodeAt(index);
  return difference === 0;
}

/**
 * Whether a request body has an encoding a cross-site HTML form (or a no-cors
 * fetch) can send, so a session riding on it needs the form token.
 */
export function isCrossSiteSendableEncoding(contentType: string | null | undefined): boolean {
  const type = (contentType ?? "").split(";", 1)[0]!.trim().toLowerCase();
  return type === "" || type === "application/x-www-form-urlencoded" || type === "multipart/form-data" || type === "text/plain";
}

/** The store's customer session token (`cs_tok`) as the cookie header carries it (undecoded), or null. */
export function appFormSessionOfCookie(cookieHeader: string | null | undefined): string | null {
  const match = cookieHeader ? /(?:^|;\s*)cs_tok=([^;]+)/.exec(cookieHeader) : null;
  const value = match?.[1]?.trim();
  return value ? value : null;
}

/** `/apps/<plugin id>/...` (after any presence prefix is removed): the plugin id, or null. */
export function appProxyPluginOfPath(pathname: string): string | null {
  const match = /^\/apps\/([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?)\/[^/]/.exec(pathname);
  return match ? match[1]! : null;
}
