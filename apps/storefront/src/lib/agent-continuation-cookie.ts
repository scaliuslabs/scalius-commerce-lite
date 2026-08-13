const CONTINUATION_ID_PATTERN = /^acn_[A-Za-z0-9_-]{20}$/;

export function getAgentContinuationCookieName(continuationId: string): string {
  return CONTINUATION_ID_PATTERN.test(continuationId)
    ? `__Host-sc_agent_${continuationId.slice(4)}`
    : "";
}

export function createAgentContinuationCookieHeader(
  continuationId: string,
  maxAgeSeconds: number,
): string | null {
  const name = getAgentContinuationCookieName(continuationId);
  if (!name || !Number.isFinite(maxAgeSeconds)) return null;
  const maxAge = Math.max(1, Math.min(30 * 60, Math.floor(maxAgeSeconds)));
  return `${name}=${continuationId}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax; Secure`;
}

export function readAgentContinuationCookie(
  cookieHeader: string | null | undefined,
  continuationId: string,
): string {
  const name = getAgentContinuationCookieName(continuationId);
  if (!cookieHeader || !name) return "";
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value === continuationId ? value : "";
  }
  return "";
}
