function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "[::1]";
}

/**
 * Accept only navigable hosted-checkout URLs. Production payment redirects must
 * use HTTPS; loopback HTTP remains available for local gateway development.
 */
export function normalizeHostedCheckoutUrl(
  value: string | null | undefined,
): string | null {
  const raw = value?.trim();
  if (!raw) return null;

  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password) return null;
    if (
      parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))
    ) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

/** Permit same-store relative recovery/receipt paths or a safe hosted URL. */
export function normalizeCheckoutRedirectUrl(
  value: string | null | undefined,
  storefrontOrigin: string,
): string | null {
  const raw = value?.trim();
  if (!raw) return null;

  try {
    const origin = new URL(storefrontOrigin).origin;
    const parsed = new URL(raw, `${origin}/`);
    if (parsed.origin === origin) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    return normalizeHostedCheckoutUrl(raw);
  } catch {
    return null;
  }
}
