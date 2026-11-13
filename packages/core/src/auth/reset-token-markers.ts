import { sha256Hex } from "@scalius/shared/hash";
// Reset and invite links. The token is a bearer secret mailed in a link, so it
// is never stored: Better Auth asks for `reset-password:<token>`, and its
// `storeIdentifier` hook (auth.ts) stores the row as `reset-link:<sha256 of
// the token>`. Once the link is used or its invite is cancelled, a marker
// `reset-link:used:<hash>` / `reset-link:cancelled:<hash>` is kept so the link
// page can say which.
//
// Nothing is stored under Better Auth's own `reset-password:` prefix. Better
// Auth also looks a hashed identifier up as given; under its prefix a stored
// hash or marker could then be presented as a token.

export const RESET_TOKEN_MARKER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The prefix of the identifier Better Auth asks for: `reset-password:<token>`. */
export const BETTER_AUTH_RESET_PREFIX = "reset-password:";

/** The prefix of every stored reset or invite link row: live links and their markers. */
export const RESET_LINK_PREFIX = "reset-link:";

const TOKEN_HASH = /^[0-9a-f]{64}$/;

/** The stored identifier of a live link with this token. */
export async function liveResetIdentifier(token: string): Promise<string> {
  return `${RESET_LINK_PREFIX}${await sha256Hex(token)}`;
}

/** The stored identifier of the marker for a link with this token. */
export async function resetTokenMarkerIdentifier(kind: "used" | "cancelled", token: string): Promise<string> {
  return resetTokenMarkerIdentifierForHash(kind, await sha256Hex(token));
}

/** The stored identifier of the marker for a link whose token has this hash. */
export function resetTokenMarkerIdentifierForHash(kind: "used" | "cancelled", tokenHash: string): string {
  return `${RESET_LINK_PREFIX}${kind}:${tokenHash}`;
}

/** The token hash of a live link's row, or null for a marker or any other row. */
export function liveResetTokenHash(identifier: string): string | null {
  if (!identifier.startsWith(RESET_LINK_PREFIX)) return null;
  const hash = identifier.slice(RESET_LINK_PREFIX.length);
  return TOKEN_HASH.test(hash) ? hash : null;
}
