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

/**
 * Clears the customer session cookies (`cs_tok` and its `cs_auth` hint):
 * appended to a placed order's response when its session had ended
 * (`X-Customer-Session-Ended`), so the browser stops sending a dead session.
 */
export const ENDED_CUSTOMER_SESSION_COOKIES = [
  "cs_tok=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure",
  "cs_auth=; Max-Age=0; Path=/; SameSite=Lax; Secure",
] as const;
