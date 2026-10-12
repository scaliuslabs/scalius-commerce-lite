import { queryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminNavigationMenus,
  getApiV1AdminNavigationMenusByMenuId,
  getApiV1AdminNavigationPlacementSettings,
  getApiV1AdminSettingsSeoFeedDiagnostics,
  getApiV1AdminSettingsThemeEditor,
} from "@scalius/api-client/sdk";
import { apiData, type ApiResult } from "../api";
import { queryKeys } from "../query-keys";
import type {
  NavigationMenuSummary,
  NavigationPlacementSetting,
} from "./navigation";

/** The published theme, the shared draft, who published last, and what the editor reads (store shape, every image the draft names, app surfaces). */
export type ThemeWorkspaceDocument = ApiResult<typeof getApiV1AdminSettingsThemeEditor>;
/** An active app with the homepage sections, theme slots, templates and product-page blocks it offers the theme. */
export type ThemeApp = ThemeWorkspaceDocument["apps"][number];
export type ThemeAppSection = ThemeApp["sections"][number];
export type ThemeAppBlock = ThemeApp["productBlocks"][number];
/** A theme slot (header, footer, product card) an app fills, with its settings. */
export type ThemeAppSlot = ThemeApp["slots"][number];
/** One setting of an app section or block, as the app's manifest declares it (labels are the app's plain text). */
export type ThemeAppSettingField = ThemeAppSection["settings"][number];
/** The menu detail is the stored row: no item or placement counts. */
export type NavigationMenuRecord = Omit<NavigationMenuSummary, "itemCount" | "placementCount">;
export type FeedDiagnostics = ApiResult<typeof getApiV1AdminSettingsSeoFeedDiagnostics>;

export const themeWorkspaceQueryOptions = () =>
  queryOptions({
    queryKey: [...queryKeys.settings.theme(), "workspace"] as const,
    queryFn: () => apiData(getApiV1AdminSettingsThemeEditor()),
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
