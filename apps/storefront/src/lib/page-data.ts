// src/lib/page-data.ts
// Utility for parallelizing layout and page data fetches to reduce cold start latency

import { getLayoutData, type LayoutData } from "./api";

export type PageDataResult<T> = {
  layoutData: LayoutData | null;
  pageData: T;
};

/**
 * Loads layout data in parallel with page-specific data.
 * This reduces cold start latency by running both fetches concurrently
 * instead of sequentially (Layout first, then page content).
 *
 * @param pageDataFetcher - Function that fetches page-specific data
 * @returns Object containing both layoutData and pageData
 *
 * @example
 * ```typescript
 * const { layoutData, pageData: homepageData } = await loadPageWithLayout(
 *   () => getHomepageData()
 * );
 * ```
 */
export async function loadPageWithLayout<T>(
  pageDataFetcher: () => Promise<T>,
): Promise<PageDataResult<T>> {
  const [layoutData, pageData] = await Promise.all([
    getLayoutData(),
    pageDataFetcher(),
  ]);
  return { layoutData, pageData };
}

/**
 * For pages that only need layout data (no page-specific data).
 * @returns Layout data or null if fetch fails
 */
export async function loadLayoutOnly(): Promise<LayoutData | null> {
  return getLayoutData();
}
