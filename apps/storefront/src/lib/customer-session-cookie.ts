export function getCustomerSessionTokenFromCookie(
  cookieHeader: string | null | undefined,
): string | null {
  if (!cookieHeader) return null;

  const match = cookieHeader.match(/(?:^|;\s*)cs_tok=([^;]+)/);
  const rawToken = match?.[1];
  if (!rawToken) return null;

  try {
    return decodeURIComponent(rawToken);
  } catch {
    return rawToken;
  }
}
