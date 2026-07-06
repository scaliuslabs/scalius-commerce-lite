/**
 * Resolves any media URL to a canonical storefront-safe URL.
 *
 * Handles bare R2 object keys, already-complete URLs, local/CDN-optimized
 * paths, and dashboard-configured CDN aliases.
 *
 * This is a pure function: it accepts CDN configuration as parameters rather
 * than reading app runtime state directly. Each app is responsible for loading
 * settings from its own runtime environment and passing them in.
 */

export interface MediaUrlResolutionOptions {
  /**
   * Hostnames whose object paths should be served from `cdnBase`.
   * Configure these from the admin media settings during CDN cutovers.
   */
  cdnHostAliases?: string[];
}

function toUrl(value: string | undefined): URL | null {
  const raw = value?.trim();
  if (!raw) return null;

  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return null;
  }
}

function toHostname(value: string | undefined): string {
  const parsed = toUrl(value);
  if (parsed) return parsed.hostname.toLowerCase();

  return (
    value
      ?.trim()
      .replace(/^https?:\/\//, "")
      .split("/")[0]
      ?.toLowerCase() || ""
  );
}

function toCanonicalCdnBase(value: string | undefined): URL | null {
  const parsed = toUrl(value?.replace(/\/$/, ""));
  return parsed && /^https?:$/.test(parsed.protocol) ? parsed : null;
}

function getAliasHosts(
  options: MediaUrlResolutionOptions | undefined,
): Set<string> {
  const hosts = new Set<string>();
  for (const host of options?.cdnHostAliases ?? []) {
    const normalized = toHostname(host);
    if (normalized) hosts.add(normalized);
  }
  return hosts;
}

const HTTP_URL_RE = /^https?:\/\//i;

function hasUnsafeMediaSourceChars(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (char === "\\" || code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isSafeBareObjectKey(value: string): boolean {
  return !value.includes(":") && !hasUnsafeMediaSourceChars(value);
}

function isSafeLocalPath(value: string): boolean {
  return (
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !hasUnsafeMediaSourceChars(value)
  );
}

/**
 * Resolve a media URL to an absolute CDN URL when possible.
 *
 * @param url - The original image URL or bare R2 object key
 * @param cdnBase - The canonical CDN base URL. When empty/undefined, bare R2
 *   keys are returned as-is.
 * @param options - Optional dashboard-loaded alias configuration
 * @returns Resolved URL, or empty string for null/undefined/empty input
 */
export function resolveMediaUrl(
  url: string | null | undefined,
  cdnBase?: string,
  options?: MediaUrlResolutionOptions,
): string {
  const trimmed = url?.trim();
  if (!trimmed) return "";

  const canonicalBase = toCanonicalCdnBase(cdnBase);

  if (HTTP_URL_RE.test(trimmed)) {
    if (hasUnsafeMediaSourceChars(trimmed)) return "";

    const parsed = toUrl(trimmed);
    if (!parsed || !/^https?:$/.test(parsed.protocol)) return "";

    const aliasHosts = getAliasHosts(options);

    if (
      canonicalBase &&
      aliasHosts.has(parsed.hostname.toLowerCase())
    ) {
      return `${canonicalBase.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }

    return trimmed;
  }

  // Already a Cloudflare-optimized path
  if (trimmed.startsWith("/cdn-cgi/")) {
    return isSafeLocalPath(trimmed) ? trimmed : "";
  }

  // Local asset path (e.g. /img/no-image.webp)
  if (trimmed.startsWith("/")) {
    return isSafeLocalPath(trimmed) ? trimmed : "";
  }

  if (!isSafeBareObjectKey(trimmed)) return "";

  // Bare R2 object key — prepend CDN base
  const base = cdnBase?.replace(/\/$/, "");
  return base ? `${base}/${trimmed}` : trimmed;
}
