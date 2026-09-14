// Settings -> System -> Platform: the deployment's public origins.
// Backed by operationIds dashboard.settings.platform_get / platform_update.
import type {
  GetApiV1AdminSettingsPlatformResponses,
  PutApiV1AdminSettingsPlatformData,
} from "@scalius/api-client/types";
import { createAdminApiFunction as createServerFn } from "../admin-api-function";
import { apiGet, apiPut } from "../api";

type ApiEnvelopeData<T> = T extends { success: true; data: infer D } ? D : never;

export type PlatformSettingsPayload = ApiEnvelopeData<
  GetApiV1AdminSettingsPlatformResponses[200]
>;
export type PlatformSettingsReadiness = PlatformSettingsPayload["readiness"];
export type PlatformSettingsEffective = PlatformSettingsPayload["effective"];
export type PlatformUrlKey = PlatformSettingsReadiness["missing"][number];
export type UpdatePlatformSettingsInput = PutApiV1AdminSettingsPlatformData["body"];

const PLATFORM_SETTINGS_PATH = "/settings/platform";

export const getPlatformSettings = createServerFn({ method: "GET" }).handler(
  async () => apiGet<PlatformSettingsPayload>(PLATFORM_SETTINGS_PATH),
);

export const updatePlatformSettings = createServerFn({ method: "POST" })
  .validator((data: UpdatePlatformSettingsInput) => data)
  .handler(async ({ data }) =>
    apiPut<PlatformSettingsPayload>(PLATFORM_SETTINGS_PATH, data),
  );
