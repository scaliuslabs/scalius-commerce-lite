function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function normalizeNamespace(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).hostname;
  } catch {
    return trimmed;
  }
}

export function resolveCacheNamespace(
  env: Pick<Env, "CACHE_NAMESPACE" | "STOREFRONT_URL"> | null | undefined,
  requestHostname: string,
): string {
  const explicitNamespace = normalizeNamespace(env?.CACHE_NAMESPACE ?? "");
  if (explicitNamespace) {
    return explicitNamespace;
  }

  if (isLocalHostname(requestHostname)) {
    return requestHostname;
  }

  const storefrontNamespace = normalizeNamespace(env?.STOREFRONT_URL ?? "");
  return storefrontNamespace ?? requestHostname;
}
