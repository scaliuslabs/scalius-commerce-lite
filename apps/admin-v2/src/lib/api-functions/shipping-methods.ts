import { createServerFn } from "@tanstack/react-start";
import { apiDelete, apiGet, apiPost, apiPut } from "../api.server";

export type ShippingMethodsQueryInput = {
  [key: string]: string | number | boolean | undefined;
  page?: number;
  limit?: number;
  search?: string;
  sort?: string;
  order?: string;
  trashed?: boolean;
};

export interface ShippingMethod {
  id: string;
  name: string;
  fee: number;
  description: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: number | null;
  updatedAt: number | null;
  deletedAt: number | null;
}

export interface ShippingMethodsPagination {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface ShippingMethodsPayload {
  shippingMethods: ShippingMethod[];
  pagination: ShippingMethodsPagination;
}

export interface ShippingMethodPayload {
  shippingMethod: ShippingMethod;
}

export interface ShippingMethodWriteInput {
  name?: string;
  fee?: number;
  description?: string | null;
  isActive?: boolean;
  sortOrder?: number;
}

export interface UpdateShippingMethodInput {
  id: string;
  update: ShippingMethodWriteInput;
}

export interface ShippingMethodIdInput {
  id: string;
}

export const getShippingMethods = createServerFn({ method: "GET" })
  .validator((data: ShippingMethodsQueryInput) => data)
  .handler(async ({ data }) => {
    const params: Record<string, string> = {};
    if (data.page) params.page = String(data.page);
    if (data.limit) params.limit = String(data.limit);
    if (data.search) params.search = data.search;
    if (data.sort) params.sort = data.sort;
    if (data.order) params.order = data.order;
    if (data.trashed) params.trashed = "true";
    return apiGet<ShippingMethodsPayload>("/settings/shipping-methods", params);
  });

export const createShippingMethod = createServerFn({ method: "POST" })
  .validator((data: ShippingMethodWriteInput) => data)
  .handler(async ({ data }) => {
    return apiPost<ShippingMethodPayload>("/settings/shipping-methods", data);
  });

export const updateShippingMethod = createServerFn({ method: "POST" })
  .validator((data: UpdateShippingMethodInput) => data)
  .handler(async ({ data }) => {
    return apiPut<ShippingMethodPayload>(
      `/settings/shipping-methods/${data.id}`,
      data.update,
    );
  });

export const deleteShippingMethod = createServerFn({ method: "POST" })
  .validator((data: ShippingMethodIdInput) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/settings/shipping-methods/${data.id}`);
  });

export const permanentDeleteShippingMethod = createServerFn({ method: "POST" })
  .validator((data: ShippingMethodIdInput) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/settings/shipping-methods/${data.id}/permanent-delete`);
  });

export const restoreShippingMethod = createServerFn({ method: "POST" })
  .validator((data: ShippingMethodIdInput) => data)
  .handler(async ({ data }) => {
    return apiPost<{ message?: string }>(
      `/settings/shipping-methods/${data.id}/restore`,
    );
  });
