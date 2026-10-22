// Apps (installed plugins, packages/plugin-sdk/docs/apps.md): the Apps list and one
// app's page. Every write is guarded by the revision the page showed; an
// activation also sends back the grant key, so a Super Admin approves exactly
// the access the page listed. Secret settings are write-only: reads say only
// whether one is set. The writes live in `../api-mutations/apps.ts`, with the
// screens that make them, so the shell's app reads stay light.
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminApps,
  getApiV1AdminAppsById,
  getApiV1AdminAppsByIdDeliveries,
  getApiV1AdminAppsByIdLogs,
  getApiV1AdminAppsRemovedData,
  getApiV1AdminAppsStorefrontProblems,
  getApiV1AdminAppsSurfaces,
} from "@scalius/api-client/sdk";
import type {
  AppAdminSurfaces,
  AppDetail,
  AppEventDelivery,
  AppFeature,
  AppGrant,
  AppListing,
  AppLogLine,
  AppSettingField,
  AppStorefrontProblem,
  AppSummary,
  RemovedAppData,
} from "@scalius/api-client/types";
import { apiData } from "../api";
import { queryKeys } from "../query-keys";

export type { AppAdminSurfaces, AppDetail, AppEventDelivery, AppFeature, AppGrant, AppListing, AppLogLine, AppSettingField, AppStorefrontProblem, AppSummary, RemovedAppData };

/** The categories an app lists itself under (the manifest's enum). */
export type AppCategory = AppSummary["categories"][number];

/** The checkout points an app can implement, in the order checkout reaches them. */
export const APP_FUNCTION_POINTS = [
  "cart.transform",
  "cart.line_prices",
  "cart.validate",
  "checkout.discounts",
  "checkout.shipping_rates",
  "checkout.payment_methods",
] as const;
export type AppFunctionPoint = (typeof APP_FUNCTION_POINTS)[number];

/** A checkout function the app implements; at one point, lower priority runs first. */
export type AppFunction = AppSummary["functions"][number];

/** A settings value as the API stores it (`null` clears an optional field). */
export type AppSettingValue = string | number | boolean | string[] | null;
export type AppDeliveryStatus = AppEventDelivery["status"];

/** A delivery that ended without success can be sent again. */
export const RETRYABLE_APP_DELIVERY_STATUSES: ReadonlySet<string> = new Set<AppDeliveryStatus>(["failed", "exhausted", "cancelled"]);

export const APP_DELIVERIES_PAGE_SIZE = 25;
export const APP_LOG_PAGE_SIZE = 50;

export const appsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.apps.list(),
    queryFn: () => apiData(getApiV1AdminApps()),
  });

/**
 * Apps whose storefront section, block or design the store drew without in
 * the last day, newest first (one per app). The theme editor and an app's
 * page show it; a quick refresh keeps a fix visible soon after it lands.
 */
export const appStorefrontProblemsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.apps.storefrontProblems(),
    queryFn: async (): Promise<AppStorefrontProblem[]> => (await apiData(getApiV1AdminAppsStorefrontProblems())).problems,
    staleTime: 30_000,
    retry: false,
  });

export const appQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.apps.detail(id),
    queryFn: async () => (await apiData(getApiV1AdminAppsById({ path: { id } }))).app,
  });

/** Surfaces change only when an app is activated, updated or removed (which refreshes them). */
export const APP_SURFACES_STALE_TIME_MS = 5 * 60 * 1000;

/**
 * Every active app's dashboard surfaces: pages (navigation), resource cards,
 * actions and home widgets, plus the admin routes each app declares (a
 * button may only ever call one of those). Read only by staff with apps.view.
 */
export const appSurfacesQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.apps.surfaces(),
    queryFn: async (): Promise<AppAdminSurfaces[]> => (await apiData(getApiV1AdminAppsSurfaces())).apps,
    staleTime: APP_SURFACES_STALE_TIME_MS,
  });

/** Newest deliveries first, one page per "Load more". `status` narrows to one delivery status. */
export const appDeliveriesQueryOptions = (id: string, status: AppDeliveryStatus | null) =>
  infiniteQueryOptions({
    queryKey: queryKeys.apps.deliveries(id, status ?? "all"),
    queryFn: ({ pageParam }) =>
      apiData(getApiV1AdminAppsByIdDeliveries({
        path: { id },
        query: { status: status ?? undefined, cursor: pageParam, limit: APP_DELIVERIES_PAGE_SIZE },
      })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

/** Newest log lines first; the next page starts before the last line shown. */
export const appLogsQueryOptions = (id: string) =>
  infiniteQueryOptions({
    queryKey: queryKeys.apps.logs(id),
    queryFn: ({ pageParam }) =>
      apiData(getApiV1AdminAppsByIdLogs({ path: { id }, query: { before: pageParam, limit: APP_LOG_PAGE_SIZE } })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

/** What apps that are no longer installed left in the store, one group per app. */
export const removedAppDataQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.apps.removedData(),
    queryFn: async () => (await apiData(getApiV1AdminAppsRemovedData())).apps,
  });
