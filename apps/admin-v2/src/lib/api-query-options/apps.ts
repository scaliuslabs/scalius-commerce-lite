// Apps (installed plugins, docs/platform/PLUGINS.md): the Apps list and one
// app's page. Every write is guarded by the revision the page showed; an
// activation also sends back the grant key, so a Super Admin approves exactly
// the access the page listed. Secret settings are write-only: reads say only
// whether one is set.
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminApps,
  getApiV1AdminAppsById,
  getApiV1AdminAppsByIdDeliveries,
  getApiV1AdminAppsByIdLogs,
  getApiV1AdminAppsSurfaces,
  postApiV1AdminAppsByIdActivate,
  postApiV1AdminAppsByIdDeactivate,
  postApiV1AdminAppsByIdDeliveriesByDeliveryIdRetry,
  postApiV1AdminAppsByIdUninstall,
  putApiV1AdminAppsByIdSettings,
} from "@scalius/api-client/sdk";
import type {
  AppAdminSurfaces,
  AppDetail,
  AppEventDelivery,
  AppGrant,
  AppListing,
  AppLogLine,
  AppSettingField,
  AppSummary,
} from "@scalius/api-client/types";
import { AdminApiResponseError } from "../admin-api-error";
import { apiData } from "../api";
import { queryKeys } from "../query-keys";

export type { AppAdminSurfaces, AppDetail, AppEventDelivery, AppGrant, AppListing, AppLogLine, AppSettingField, AppSummary };

/** The categories an app lists itself under (the manifest's enum). */
export type AppCategory = AppSummary["categories"][number];

/** The checkout points an app can implement, in the order checkout reaches them. */
export const APP_FUNCTION_POINTS = ["cart.validate", "checkout.discounts", "checkout.shipping_rates", "checkout.payment_methods", "order.risk"] as const;
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

/** Super Admin only. `grantKey` is the one the page showed; a changed request answers 409. */
export function activateApp(app: Pick<AppDetail, "id" | "revision" | "grantKey">) {
  return apiData(postApiV1AdminAppsByIdActivate({
    path: { id: app.id },
    body: { expectedRevision: app.revision, grantKey: app.grantKey },
  }));
}

export function deactivateApp(app: Pick<AppDetail, "id" | "revision">) {
  return apiData(postApiV1AdminAppsByIdDeactivate({ path: { id: app.id }, body: { expectedRevision: app.revision } }));
}

/** Every plain field; a secret only when it changes (a string sets it, null clears it). */
export async function saveAppSettings(app: Pick<AppDetail, "id" | "revision">, values: Record<string, AppSettingValue>) {
  const { app: saved } = await apiData(putApiV1AdminAppsByIdSettings({
    path: { id: app.id },
    body: { expectedRevision: app.revision, values },
  }));
  return saved;
}

export function uninstallApp(app: Pick<AppDetail, "id" | "revision">, keepData: boolean) {
  return apiData(postApiV1AdminAppsByIdUninstall({ path: { id: app.id }, body: { expectedRevision: app.revision, keepData } }));
}

export async function retryAppDelivery(id: string, deliveryId: string) {
  const { delivery } = await apiData(postApiV1AdminAppsByIdDeliveriesByDeliveryIdRetry({ path: { id, deliveryId } }));
  return delivery;
}

/** The app platform's own refusal code (`installation.grant_changed`), or null. */
export function appErrorCode(error: unknown): string | null {
  if (!(error instanceof AdminApiResponseError) || error.code !== "PLUGIN_ERROR") return null;
  const code = (error.details as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : null;
}

/** The app changed after the page loaded it (another tab, another person, or an update). */
export function isAppChangedError(error: unknown): boolean {
  const code = appErrorCode(error);
  return code === "installation.revision_conflict" || code === "installation.grant_changed";
}

/** Settings the API refused, one per key (`settings.invalid`). */
export function appSettingErrors(error: unknown): Array<{ key: string; message: string }> | null {
  if (appErrorCode(error) !== "settings.invalid") return null;
  const errors = (error as AdminApiResponseError).details as { errors?: unknown };
  if (!Array.isArray(errors.errors)) return null;
  const list = errors.errors.flatMap((item: unknown) => {
    const entry = item as { key?: unknown; message?: unknown } | null;
    return entry && typeof entry.key === "string" && typeof entry.message === "string" ? [{ key: entry.key, message: entry.message }] : [];
  });
  return list.length > 0 ? list : null;
}
