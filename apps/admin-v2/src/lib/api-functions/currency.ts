import { createServerFn } from "@tanstack/react-start";
import { apiGet, apiPost } from "../api.server";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type SettingsPayload = { [key: string]: JsonValue };
export type MessagePayload = { message?: string };

export interface CurrencySettingsPayload {
  currencyCode: string;
  currencySymbol: string;
  usdExchangeRate: string;
}

export type UpdateCurrencySettingsInput = SettingsPayload;

export const getCurrencySettings = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<CurrencySettingsPayload>("/settings/currency");
  },
);

export const updateCurrencySettings = createServerFn({ method: "POST" })
  .validator((data: UpdateCurrencySettingsInput) => data)
  .handler(async ({ data }) => {
    return apiPost<MessagePayload>("/settings/currency", data);
  });
