export interface NormalizedCspSourceResult {
  value: string | null;
  error: string | null;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function hasForbiddenUrlParts(url: URL): boolean {
  return Boolean(
    url.username ||
    url.password ||
    (url.pathname && url.pathname !== "/") ||
    url.search ||
    url.hash,
  );
}

function isValidProtocol(url: URL): boolean {
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

function normalizeWildcardSource(raw: string): NormalizedCspSourceResult {
  const withoutScheme = raw.replace(/^https:\/\//i, "");
  if (!withoutScheme.startsWith("*.")) {
    return { value: null, error: "Wildcard sources must start with *." };
  }

  const host = withoutScheme.slice(2);
  if (!host || host.includes("*") || /[/?#@]/.test(host)) {
    return { value: null, error: "Use a wildcard host such as *.example.com." };
  }

  try {
    const parsed = new URL(`https://${host}`);
    if (hasForbiddenUrlParts(parsed) || !parsed.hostname.includes(".")) {
      return {
        value: null,
        error: "Use a complete wildcard host such as *.example.com.",
      };
    }
    return { value: `https://*.${parsed.host.toLowerCase()}`, error: null };
  } catch {
    return {
      value: null,
      error: "Use a valid wildcard host such as *.example.com.",
    };
  }
}

/**
 * Normalize one merchant-managed CSP source.
 *
 * Merchant additions are explicit HTTPS hosts. Wildcard subdomains are never
 * inferred: a merchant must enter `*.example.com` deliberately. HTTP is
 * accepted only for loopback development origins.
 */
export function normalizeMerchantCspSource(
  input: unknown,
): NormalizedCspSourceResult {
  if (typeof input !== "string" || !input.trim()) {
    return { value: null, error: "Enter a host or HTTPS origin." };
  }

  const raw = input.trim();
  if (raw.startsWith("*.") || /^https:\/\/\*\./i.test(raw)) {
    return normalizeWildcardSource(raw);
  }
  if (/^(data|blob|javascript|file|ftp):/i.test(raw) || raw === "*") {
    return { value: null, error: "Only a specific HTTPS host can be trusted." };
  }

  try {
    const parsed = new URL(
      /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`,
    );
    if (!isValidProtocol(parsed)) {
      return {
        value: null,
        error: "Use HTTPS. HTTP is allowed only for local development.",
      };
    }
    if (hasForbiddenUrlParts(parsed)) {
      return {
        value: null,
        error:
          "Enter an origin only, without credentials, a path, query, or fragment.",
      };
    }
    if (!parsed.hostname) {
      return { value: null, error: "Enter a valid host or HTTPS origin." };
    }
    return { value: parsed.origin.toLowerCase(), error: null };
  } catch {
    return { value: null, error: "Enter a valid host or HTTPS origin." };
  }
}

export function parseMerchantCspSources(input: unknown): string[] {
  if (typeof input !== "string") return [];

  const values = input
    .split(/[\n,]/)
    .map((entry) => normalizeMerchantCspSource(entry).value)
    .filter((entry): entry is string => Boolean(entry));

  return [...new Set(values)];
}

export function serializeMerchantCspSources(values: readonly string[]): string {
  return [
    ...new Set(values.flatMap((value) => parseMerchantCspSources(value))),
  ].join(",");
}

/** Normalize a configured platform URL without accepting arbitrary paths. */
export function normalizePlatformOrigin(input: unknown): string | null {
  const normalized = normalizeMerchantCspSource(input).value;
  return normalized?.includes("*") ? null : normalized;
}
