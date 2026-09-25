import { getApiV1AdminSettingsEmi } from "@scalius/api-client/sdk";
import { apiData } from "../api";

/** Settings › Payments: EMI plans (off by default). */
export const emiSettingsQuery = {
  queryKey: ["settings", "emi"] as const,
  queryFn: () => apiData(getApiV1AdminSettingsEmi()),
};
