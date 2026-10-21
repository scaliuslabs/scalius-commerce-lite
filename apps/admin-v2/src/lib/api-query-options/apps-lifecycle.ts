// The app lifecycle beyond the installed list (packages/plugin-sdk/docs/apps.md,
// "Registry", "Quotas and kill switch"): browse the registries, install or
// update from one, upload a package, the emergency stop, and the registries
// and developer keys the store trusts. Loaded on demand with the screens that
// use it, never with the Apps list's first render.
import { queryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminAppsRegistry,
  getApiV1AdminAppsRegistrySettings,
  postApiV1AdminAppsByIdStop,
  postApiV1AdminAppsByIdUpdate,
  postApiV1AdminAppsRegistryInstall,
  postApiV1AdminAppsStopThirdParty,
  postApiV1AdminAppsUpload,
  putApiV1AdminAppsRegistrySettings,
} from "@scalius/api-client/sdk";
import type { AppRegistrySettings, RegistryApp, RegistryState, TrustedAppKey } from "@scalius/api-client/types";
import { AdminApiResponseError } from "../admin-api-error";
import { apiData } from "../api";
import type { AppDetail } from "./apps";

export type { AppRegistrySettings, RegistryApp, RegistryState, TrustedAppKey };

const REGISTRY_STALE_TIME_MS = 60 * 1000;

/** Every configured registry's newest apps. The API reads the remote indexes, so this loads only when a view needs it. */
export const appRegistryQueryOptions = () =>
  queryOptions({
    queryKey: ["apps", "registry"] as const,
    queryFn: () => apiData(getApiV1AdminAppsRegistry()),
    staleTime: REGISTRY_STALE_TIME_MS,
  });

export const appRegistrySettingsQueryOptions = () =>
  queryOptions({
    queryKey: ["apps", "registry-settings"] as const,
    queryFn: () => apiData(getApiV1AdminAppsRegistrySettings()),
  });

export function installRegistryApp(app: Pick<RegistryApp, "registryId" | "id" | "version">) {
  return apiData(postApiV1AdminAppsRegistryInstall({ body: { registryId: app.registryId, id: app.id, version: app.version } }));
}

export function updateRegistryApp(app: Pick<AppDetail, "id" | "revision">, registryId: string, version: string) {
  return apiData(postApiV1AdminAppsByIdUpdate({
    path: { id: app.id },
    body: { expectedRevision: app.revision, registryId, version },
  }));
}

/** Only a Super Admin may pass `allowUnsigned` or `trustDeveloper` (the API answers 403 otherwise). */
export function uploadAppPackage(file: Blob, trust: { allowUnsigned?: boolean; trustDeveloper?: boolean } = {}) {
  return apiData(postApiV1AdminAppsUpload({
    body: file,
    query: {
      ...(trust.allowUnsigned ? { allowUnsigned: "true" as const } : {}),
      ...(trust.trustDeveloper ? { trustDeveloper: "true" as const } : {}),
    },
  }));
}

/** One app, at once, without a revision. */
export function stopApp(id: string) {
  return apiData(postApiV1AdminAppsByIdStop({ path: { id } }));
}

/** Every running app not published by Scalius. */
export function stopThirdPartyApps() {
  return apiData(postApiV1AdminAppsStopThirdParty());
}

export function saveRegistrySettings(
  expectedRevision: number,
  registries: AppRegistrySettings["registries"],
  trustedKeys: Array<{ name: string; publicKey: string }>,
) {
  return apiData(putApiV1AdminAppsRegistrySettings({ body: { expectedRevision, registries, trustedKeys } }));
}

/** The refusal's own details (`signature_untrusted` names the developer and key). */
export function appErrorDetails(error: unknown): {
  code: string | null; keyId: string | null; developer: string | null;
  /** retained_data_other_developer: the release's key (null: unsigned) and the kept group's revision. */
  releaseSigner: string | null; retainedRevision: number | null; pluginId: string | null;
} {
  const details = error instanceof AdminApiResponseError ? (error.details as Record<string, unknown> | null | undefined) : null;
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  return {
    code: text(details?.code), keyId: text(details?.keyId), developer: text(details?.developer),
    releaseSigner: text(details?.releaseSigner),
    retainedRevision: typeof details?.retainedRevision === "number" ? details.retainedRevision : null,
    pluginId: text(details?.pluginId),
  };
}

/** The API's own sentence for a refusal (plain English; shown beside the dashboard's own wording). */
export function appErrorMessage(error: unknown): string | null {
  return error instanceof AdminApiResponseError && error.message ? error.message : null;
}

/** The registry's id: its name in lowercase letters, digits and dashes, unique among the list and never `official`. */
export function registryIdFor(name: string, taken: ReadonlySet<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || "registry";
  let id = base === "official" ? "registry" : base;
  for (let n = 2; taken.has(id); n += 1) id = `${base === "official" ? "registry" : base}-${n}`;
  return id;
}
