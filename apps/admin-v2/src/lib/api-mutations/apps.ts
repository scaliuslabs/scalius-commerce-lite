// App writes (Apps list, one app's page, removed apps' data). Every write is
// guarded by the revision the page showed; an activation also sends back the
// grant key, so a Super Admin approves exactly the access the page listed.
import {
  postApiV1AdminAppsByIdActivate,
  postApiV1AdminAppsByIdDeactivate,
  postApiV1AdminAppsByIdDeliveriesByDeliveryIdRetry,
  postApiV1AdminAppsByIdFeaturesByFeatureIdDisable,
  postApiV1AdminAppsByIdFeaturesByFeatureIdEnable,
  postApiV1AdminAppsByIdUninstall,
  postApiV1AdminAppsRemovedDataByIdDelete,
  postApiV1AdminAppsRemovedDataByIdHandOver,
  putApiV1AdminAppsByIdSettings,
} from "@scalius/api-client/sdk";
import { AdminApiResponseError } from "../admin-api-error";
import { apiData } from "../api";
import type { AppDetail, AppFeature, AppSettingValue, RemovedAppData } from "../api-query-options/apps";

/** Super Admin only. `grantKey` is the one the page showed; a changed request answers 409. */
export function activateApp(app: Pick<AppDetail, "id" | "revision" | "grantKey">) {
  return apiData(postApiV1AdminAppsByIdActivate({
    path: { id: app.id },
    body: { expectedRevision: app.revision, grantKey: app.grantKey },
  }));
}

/**
 * Super Admin only: turns one feature on and approves its access. `grantKey`
 * is the feature's, as the page showed it; a changed request answers 409.
 */
export function enableAppFeature(app: Pick<AppDetail, "id" | "revision">, feature: Pick<AppFeature, "id" | "grantKey">) {
  return apiData(postApiV1AdminAppsByIdFeaturesByFeatureIdEnable({
    path: { id: app.id, featureId: feature.id },
    body: { expectedRevision: app.revision, grantKey: feature.grantKey ?? "" },
  }));
}

/** Turns one feature off: its access is revoked at once (no approval). */
export function disableAppFeature(app: Pick<AppDetail, "id" | "revision">, featureId: string) {
  return apiData(postApiV1AdminAppsByIdFeaturesByFeatureIdDisable({
    path: { id: app.id, featureId },
    body: { expectedRevision: app.revision },
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

/** Permanently deletes one removed app's group, if it is still the one the page listed. */
export function deleteRemovedAppData(group: Pick<RemovedAppData, "id" | "revision">) {
  return apiData(postApiV1AdminAppsRemovedDataByIdDelete({ path: { id: group.id }, body: { expectedRevision: group.revision } }));
}

/**
 * Lets the release signed with `signerKeyId` (null: the store's own bundled
 * code or an unsigned upload) take a removed app's kept data, if the group is
 * still the one the page listed. A waiting bundled release installs at once.
 */
export function handOverRemovedAppData(group: Pick<RemovedAppData, "id" | "revision">, signerKeyId: string | null) {
  return apiData(postApiV1AdminAppsRemovedDataByIdHandOver({ path: { id: group.id }, body: { expectedRevision: group.revision, signerKeyId } }));
}

export async function retryAppDelivery(id: string, deliveryId: string) {
  const { delivery } = await apiData(postApiV1AdminAppsByIdDeliveriesByDeliveryIdRetry({ path: { id, deliveryId } }));
  return delivery;
}

/** The app platform's own refusal code (`installation_grant_changed`), or null. */
export function appErrorCode(error: unknown): string | null {
  if (!(error instanceof AdminApiResponseError) || error.code !== "plugin_error") return null;
  const code = (error.details as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : null;
}

/** The app changed after the page loaded it (another tab, another person, or an update). */
export function isAppChangedError(error: unknown): boolean {
  const code = appErrorCode(error);
  return code === "installation_revision_conflict" || code === "installation_grant_changed";
}

/** Settings the API refused, one per key (`settings_invalid`). */
export function appSettingErrors(error: unknown): Array<{ key: string; message: string }> | null {
  if (appErrorCode(error) !== "settings_invalid") return null;
  const errors = (error as AdminApiResponseError).details as { errors?: unknown };
  if (!Array.isArray(errors.errors)) return null;
  const list = errors.errors.flatMap((item: unknown) => {
    const entry = item as { key?: unknown; message?: unknown } | null;
    return entry && typeof entry.key === "string" && typeof entry.message === "string" ? [{ key: entry.key, message: entry.message }] : [];
  });
  return list.length > 0 ? list : null;
}
