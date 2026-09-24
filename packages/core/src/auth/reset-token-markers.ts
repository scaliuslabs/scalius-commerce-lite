// What happened to a reset or invite link that no longer works. Better Auth
// keeps a live link as a `reset-password:<token>` verification row; once the
// link is used or its invite is cancelled, a hash of the token is kept under
// `reset-password:used:*` / `reset-password:cancelled:*` so the link page can
// say which. The token itself is never stored in a marker.

export const RESET_TOKEN_MARKER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const LIVE_PREFIX = "reset-password:";

export async function resetTokenMarkerIdentifier(kind: "used" | "cancelled", token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${LIVE_PREFIX}${kind}:${hex}`;
}

/** The token of a live link's verification row, or null for a marker row. */
export function liveResetToken(identifier: string): string | null {
  if (!identifier.startsWith(LIVE_PREFIX)) return null;
  const token = identifier.slice(LIVE_PREFIX.length);
  return token.startsWith("used:") || token.startsWith("cancelled:") ? null : token;
}
