import { createAdminApiFunction as createServerFn } from "../admin-api-function";
import { normalizeSupportedCurrencyCode } from "@scalius/shared/currency";
import { apiGet, apiPost } from "../api";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type SettingsPayload = { [key: string]: JsonValue };
export type MessagePayload = { message?: string };

export interface CurrencySettingsPayload {
  currencyCode: string;
  currencySymbol: string;
  usdExchangeRate: string;
  currencyCodeLocked: boolean;
}

export type UpdateCurrencySettingsInput = SettingsPayload;

export function normalizeCurrencySettingsInput(
  input: UpdateCurrencySettingsInput,
): UpdateCurrencySettingsInput {
  if (!("currencyCode" in input)) return input;
  const currencyCode = normalizeSupportedCurrencyCode(input.currencyCode);
  if (!currencyCode) {
    throw new Error("Select a supported three-letter currency code.");
  }
  return { ...input, currencyCode };
}

export const getCurrencySettings = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<CurrencySettingsPayload>("/settings/currency");
  },
);

export const updateCurrencySettings = createServerFn({ method: "POST" })
  .validator(normalizeCurrencySettingsInput)
  .handler(async ({ data }) => {
    return apiPost<MessagePayload>("/settings/currency", data);
  });
