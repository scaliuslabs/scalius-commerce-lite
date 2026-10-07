/**
 * A page's URL in each store language (MARKETS-DESIGN D9). The API returns a
 * resource's localized handles (`localizedSlugs`, locale → handle) and its
 * source handle (`sourceSlug`) only when it has a localized handle, so a
 * single-language store's pages carry neither and keep today's alternates.
 * A merchant's canonical path override names one URL for every language.
 */
export interface LocalizedPaths {
  /** The page's path in every language without its own handle (the source handle's). */
  source: string;
  /** The page's path by locale where it has a localized handle. */
  byLocale: Record<string, string>;
}

export interface LocalizedHandles {
  localizedSlugs?: Record<string, string> | null;
  sourceSlug?: string | null;
  canonicalPath?: string | null;
}

/** The page's paths by language, or null when it has no localized handle (or a canonical override). */
export function localizedPaths(
  resource: LocalizedHandles | null | undefined,
  pathOf: (handle: string) => string,
): LocalizedPaths | null {
  const handles = resource?.localizedSlugs;
  if (!resource?.sourceSlug || !handles || Object.keys(handles).length === 0) return null;
  if (resource.canonicalPath?.trim()) return null;
  return {
    source: pathOf(resource.sourceSlug),
    byLocale: Object.fromEntries(Object.entries(handles).map(([locale, handle]) => [locale, pathOf(handle)])),
  };
}
