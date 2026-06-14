import { createServerFn } from "@tanstack/react-start";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from "../api.server";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type CheckoutLanguagesQueryInput = {
  [key: string]: string | number | boolean | undefined;
  page?: number;
  limit?: number;
  search?: string;
  sort?: string;
  order?: "asc" | "desc";
  trashed?: boolean;
};

export interface CheckoutLanguage {
  id: string;
  name: string;
  code: string;
  languageData: string | Record<string, JsonValue>;
  fieldVisibility: string | Record<string, JsonValue>;
  isActive: boolean;
  isDefault: boolean;
  createdAt: string | number;
  updatedAt: string | number;
  deletedAt: string | number | null;
}

export interface CheckoutLanguagesPagination {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface CheckoutLanguagesPayload {
  languages: CheckoutLanguage[];
  pagination: CheckoutLanguagesPagination;
}

export interface CheckoutLanguagePayload {
  language?: CheckoutLanguage;
}

export interface CheckoutLanguageWriteInput {
  name?: string;
  code?: string;
  languageData?: Record<string, string>;
  fieldVisibility?: Record<string, boolean>;
  isActive?: boolean;
  isDefault?: boolean;
}

export interface UpdateCheckoutLanguageInput {
  id: string;
  update: CheckoutLanguageWriteInput;
}

export interface CheckoutLanguageIdInput {
  id: string;
}

export const getCheckoutLanguages = createServerFn({ method: "GET" })
  .validator((data: CheckoutLanguagesQueryInput) => data)
  .handler(async ({ data }) => {
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined && value !== "") params[key] = String(value);
    }
    return apiGet<CheckoutLanguagesPayload>(
      "/settings/checkout-languages",
      params,
    );
  });

export const createCheckoutLanguage = createServerFn({ method: "POST" })
  .validator((data: CheckoutLanguageWriteInput) => data)
  .handler(async ({ data }) => {
    return apiPost<CheckoutLanguagePayload>(
      "/settings/checkout-languages",
      data,
    );
  });

export const updateCheckoutLanguage = createServerFn({ method: "POST" })
  .validator((data: UpdateCheckoutLanguageInput) => data)
  .handler(async ({ data }) => {
    return apiPut<CheckoutLanguagePayload>(
      `/settings/checkout-languages/${data.id}`,
      data.update,
    );
  });

export const softDeleteCheckoutLanguage = createServerFn({ method: "POST" })
  .validator((data: CheckoutLanguageIdInput) => data)
  .handler(async ({ data }) => {
    return apiPatch<Record<string, never>>(
      `/settings/checkout-languages/${data.id}`,
    );
  });

export const deleteCheckoutLanguage = createServerFn({ method: "POST" })
  .validator((data: CheckoutLanguageIdInput) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/settings/checkout-languages/${data.id}`);
  });

export const restoreCheckoutLanguage = createServerFn({ method: "POST" })
  .validator((data: CheckoutLanguageIdInput) => data)
  .handler(async ({ data }) => {
    return apiPost<Record<string, never>>(
      `/settings/checkout-languages/${data.id}/restore`,
    );
  });
