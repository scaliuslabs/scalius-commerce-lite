import { queryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminSettingsCurrency,
  type postApiV1AdminSettingsCurrency,
} from "@scalius/api-client/sdk";
import { normalizeSupportedCurrencyCode } from "@scalius/shared/currency";
import { apiData, type ApiBody, type ApiResult } from "../api";
import { queryKeys } from "../query-keys";

const CONFIG_STALE_TIME_MS = 1000 * 60 * 30;

export type CurrencySettingsPayload = ApiResult<typeof getApiV1AdminSettingsCurrency>;
type UpdateCurrencySettingsInput = ApiBody<typeof postApiV1AdminSettingsCurrency>;

/** Rejects an unsupported code before it reaches the API. */
export function normalizeCurrencySettingsInput(
  input: Record<string, unknown>,
): UpdateCurrencySettingsInput {
  if (!("currencyCode" in input)) return input as UpdateCurrencySettingsInput;
  const currencyCode = normalizeSupportedCurrencyCode(input.currencyCode);
  if (!currencyCode) {
    throw new Error("Select a supported three-letter currency code.");
  }
  return { ...input, currencyCode } as UpdateCurrencySettingsInput;
}

export const currencySettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.currency(),
    queryFn: () => apiData(getApiV1AdminSettingsCurrency()),
    staleTime: CONFIG_STALE_TIME_MS,
  });
