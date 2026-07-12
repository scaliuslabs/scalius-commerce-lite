export interface CatalogDiscoveryImageOptions {
  transformImageUrl?: (source: string) => string | null | undefined;
}

function cleanString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function hasUnsafeUrlChars(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (char === "\\" || code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function parseAbsoluteHttpUrl(value: string | null | undefined): URL | null {
  const source = cleanString(value);
  if (!source || source.startsWith("//") || hasUnsafeUrlChars(source)) {
    return null;
  }

  try {
    const parsed = new URL(source);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** Validate a persisted catalog image source without needing a store origin. */
export function isCatalogDiscoveryImageSource(
  imageUrl: string | null | undefined,
): boolean {
  const source = cleanString(imageUrl);
  if (!source || source.startsWith("//") || hasUnsafeUrlChars(source)) {
    return false;
  }

  try {
    const parsed = new URL(source, "https://catalog-source.invalid/");
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export function normalizeCatalogDiscoveryBaseUrl(
  baseUrl: string | null | undefined,
): string | null {
  const parsed = parseAbsoluteHttpUrl(baseUrl);
  if (!parsed || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    return null;
  }
  return parsed.origin;
}

export function resolveCatalogDiscoveryImageUrl(
  imageUrl: string | null | undefined,
  baseUrl: string | null | undefined,
  options: CatalogDiscoveryImageOptions = {},
): string | null {
  const base = normalizeCatalogDiscoveryBaseUrl(baseUrl);
  const source = cleanString(imageUrl);
  if (!base || !source || !isCatalogDiscoveryImageSource(source)) {
    return null;
  }

  const transformed = cleanString(
    options.transformImageUrl ? options.transformImageUrl(source) : source,
  );
  if (
    !transformed ||
    transformed.startsWith("//") ||
    hasUnsafeUrlChars(transformed)
  ) {
    return null;
  }

  try {
    const parsed = new URL(transformed, `${base}/`);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}
