/** One bounded XML/API chunk, below the sitemap protocol's 50,000 URL ceiling. */
export const SITEMAP_PAGE_SIZE = 5_000;
/**
 * The deepest page a sitemap URL may name: six digits, about five billion
 * URLs. Every supported page has an exactly representable SQL offset, and a
 * page number has one spelling of at most six digits.
 */
export const SITEMAP_MAX_PAGE = 999_999;

export interface SitemapPageOptions {
  page?: number;
  limit?: number;
}

export function sitemapPageBounds({ page = 1, limit = SITEMAP_PAGE_SIZE }: SitemapPageOptions = {}) {
  if (!Number.isSafeInteger(page) || page < 1 || page > SITEMAP_MAX_PAGE
    || !Number.isSafeInteger(limit) || limit < 1 || limit > SITEMAP_PAGE_SIZE) {
    throw new RangeError("Invalid sitemap pagination");
  }
  return { page, limit, offset: (page - 1) * limit };
}

export function sitemapPagination(page: number, limit: number, total: number) {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}

/** XML routes reject ambiguous spellings instead of serving duplicate page URLs. */
export function parseSitemapPage(value: string | null): number | null {
  if (value === null) return 1;
  if (!/^[1-9]\d*$/.test(value)) return null;
  const page = Number(value);
  return Number.isSafeInteger(page) && page <= SITEMAP_MAX_PAGE ? page : null;
}
