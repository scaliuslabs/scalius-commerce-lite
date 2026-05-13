export const PURGE_TOKEN_HEADER = "X-Purge-Token";

export function getPurgeTokenFromHeaders(headers: Headers): string | null {
  const authorization = headers.get("Authorization");
  if (authorization) {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return headers.get(PURGE_TOKEN_HEADER)?.trim() || null;
}

