/**
 * Why a trusted-website entry was refused, in merchant terms:
 * `https` — it isn't HTTPS; `path` — it has a path, query or login part;
 * `invalid` — it isn't a site address at all.
 */
export type CspSourceProblem = "https" | "path" | "invalid";

export interface NormalizedCspSourceResult {
  value: string | null;
  error: CspSourceProblem | null;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
// Browsers percent-encode junk into a "host" (`not a url` → `not%20a%20url`);
// only a real domain name or an IPv4 address counts.
const DOMAIN = /^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z\d-]{2,63}$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

const refused = (error: CspSourceProblem): NormalizedCspSourceResult => ({ value: null, error });

function hasForbiddenUrlParts(url: URL): boolean {
  return Boolean(
    url.username ||
    url.password ||
    (url.pathname && url.pathname !== "/") ||
    url.search ||
    url.hash,
  );
}

function isRealHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname) || DOMAIN.test(hostname) || IPV4.test(hostname);
}

function normalizeWildcardSource(raw: string): NormalizedCspSourceResult {
  const host = raw.replace(/^https:\/\//i, "").slice(2);
  if (/[/?#@]/.test(host)) return refused("path");
  try {
    const parsed = new URL(`https://${host}`);
    if (host.includes("*") || !DOMAIN.test(parsed.hostname)) return refused("invalid");
    return { value: `https://*.${parsed.host.toLowerCase()}`, error: null };
  } catch {
    return refused("invalid");
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
  if (typeof input !== "string" || !input.trim()) return refused("invalid");

  const raw = input.trim();
  if (/\s/.test(raw) || raw === "*" || /^(data|blob|javascript):/i.test(raw)) return refused("invalid");
  if (raw.startsWith("*.") || /^https:\/\/\*\./i.test(raw)) {
    return normalizeWildcardSource(raw);
  }

  try {
    const parsed = new URL(
      /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`,
    );
    if (!isRealHost(parsed.hostname)) return refused("invalid");
    const loopbackHttp = parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname);
    if (parsed.protocol !== "https:" && !loopbackHttp) return refused("https");
    if (hasForbiddenUrlParts(parsed)) return refused("path");
    return { value: parsed.origin.toLowerCase(), error: null };
  } catch {
    return refused("invalid");
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

/**
 * True when a CSP source list allows an origin: the same origin, or a
 * wildcard source (`https://*.example.com`) of a subdomain of its host.
 */
export function cspSourcesAllowOrigin(origin: string, sources: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const target = parsed.origin.toLowerCase();
  return sources.some((source) => {
    const value = source.toLowerCase();
    if (value === target) return true;
    const wildcard = /^(https?):\/\/\*\.([^/:]+)(?::(\d+))?$/.exec(value);
    if (!wildcard) return false;
    const port = wildcard[3] ?? "";
    return parsed.protocol === `${wildcard[1]}:` && parsed.hostname.toLowerCase().endsWith(`.${wildcard[2]}`) && parsed.port === port;
  });
}

/**
 * True when an image URL may load on a buyer's private page: a path on the
 * page's own origin, a `data:` or `blob:` URL, the page's own origin, or an
 * origin the source list allows.
 */
export function cspSourcesAllowImage(url: string, sources: readonly string[], self: string): boolean {
  if (/^\/(?![/\\])/.test(url) || /^(?:data|blob):/i.test(url)) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (self && parsed.origin === (() => { try { return new URL(self).origin; } catch { return ""; } })()) return true;
  return cspSourcesAllowOrigin(parsed.origin, sources);
}
