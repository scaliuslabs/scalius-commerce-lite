import { queryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminNavigationMenus,
  getApiV1AdminNavigationMenusByMenuId,
  getApiV1AdminNavigationPlacementSettings,
  getApiV1AdminSettingsFooter,
  getApiV1AdminSettingsHeader,
  getApiV1AdminSettingsHeroSliders,
  getApiV1AdminSettingsHomepagePresentation,
  getApiV1AdminSettingsSeoFeedDiagnostics,
  getApiV1AdminSettingsTheme,
} from "@scalius/api-client/sdk";
import { apiData, type ApiResult } from "../api";
import { queryKeys } from "../query-keys";
import type {
  NavigationMenuSummary,
  NavigationPlacementSetting,
} from "./navigation";

export type ThemeDocument = ApiResult<typeof getApiV1AdminSettingsTheme>;
export type HeaderDocument = ApiResult<typeof getApiV1AdminSettingsHeader>;
export type FooterDocument = ApiResult<typeof getApiV1AdminSettingsFooter>;
export type HeroSliderDocument = ApiResult<typeof getApiV1AdminSettingsHeroSliders>[number];
/** The menu detail is the stored row: no item or placement counts. */
export type NavigationMenuRecord = Omit<NavigationMenuSummary, "itemCount" | "placementCount">;
export type FeedDiagnostics = ApiResult<typeof getApiV1AdminSettingsSeoFeedDiagnostics>;
export type HomepageSectionsDocument = ApiResult<
  typeof getApiV1AdminSettingsHomepagePresentation
>;

export const themeQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.theme(),
    queryFn: () => apiData(getApiV1AdminSettingsTheme()),
  });

export const headerQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.header(),
    queryFn: () => apiData(getApiV1AdminSettingsHeader()),
  });

export const footerQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.footer(),
    queryFn: () => apiData(getApiV1AdminSettingsFooter()),
  });

export const heroSlidersQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.heroSliders(),
    queryFn: () => apiData(getApiV1AdminSettingsHeroSliders()),
  });

export const homepageSectionsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.homepagePresentation(),
    queryFn: () => apiData(getApiV1AdminSettingsHomepagePresentation()),
  });

export const navigationMenusQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.navigation.menus(),
    queryFn: () => apiData(getApiV1AdminNavigationMenus({ query: { limit: 100 } })),
  });

export const navigationMenuQueryOptions = (menuId: string) =>
  queryOptions({
    queryKey: queryKeys.navigation.menu(menuId),
    // Contract gap: the menu detail is declared as an open record.
    queryFn: async () =>
      (await apiData(getApiV1AdminNavigationMenusByMenuId({ path: { menuId } })))
        .menu as unknown as NavigationMenuRecord,
  });

export const navigationPlacementsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.navigation.placements(),
    queryFn: async () =>
      (await apiData(getApiV1AdminNavigationPlacementSettings()))
        .placements as unknown as NavigationPlacementSetting[],
  });

/**
 * Which products the feed leaves out and why, with up to `sampleLimit` example
 * products per reason; under the SEO key, so a save refreshes it.
 */
export const feedDiagnosticsQueryOptions = (sampleLimit = 3) =>
  queryOptions({
    queryKey: [...queryKeys.settings.seo(), "feed-diagnostics", sampleLimit] as const,
    queryFn: () => apiData(getApiV1AdminSettingsSeoFeedDiagnostics({ query: { sampleLimit } })),
  });

/** The most example products one reason lists (the API's cap). */
export const FEED_SAMPLE_MAX = 50;

type FeedReason = FeedDiagnostics["reasons"][number]["reason"];
/** Left out because of something to fix on the product; the other reasons are the merchant's own choice or setup. */
export const FIXABLE_FEED_REASONS: ReadonlySet<FeedReason> = new Set(["missing_image", "non_positive_price", "no_buyer_sku", "inconsistent_option_axes"]);

/** Products missing from the feed for a fixable reason: Home and Preferences count the same way. */
export function countFeedGaps(data: FeedDiagnostics | undefined): number {
  if (!data?.policy.productCatalogEnabled) return 0;
  return data.reasons.reduce((sum, entry) => sum + (FIXABLE_FEED_REASONS.has(entry.reason) ? entry.products : 0), 0);
}
