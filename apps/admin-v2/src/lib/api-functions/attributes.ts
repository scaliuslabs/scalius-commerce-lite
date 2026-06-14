import { createServerFn } from "@tanstack/react-start";
import { apiDelete, apiGet, apiPost, apiPut } from "../api.server";

export type AttributeTimestamp = string | number;

export interface AttributeDto {
  id: string;
  name: string;
  slug: string;
  filterable: boolean;
  options: string[] | null;
  createdAt: AttributeTimestamp;
  updatedAt: AttributeTimestamp;
  deletedAt: AttributeTimestamp | null;
  valueCount?: number;
}

export interface AttributePagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface AttributesListPayload {
  attributes: AttributeDto[];
  pagination: AttributePagination;
}

export interface AttributesQueryInput {
  [key: string]: string | number | boolean | undefined;
  page?: number;
  limit?: number;
  search?: string;
  sort?: "name" | "slug" | "filterable" | "createdAt" | "updatedAt" | string;
  order?: "asc" | "desc" | string;
  trashed?: boolean;
}

export interface CreateAttributeInput {
  name: string;
  slug: string;
  filterable?: boolean;
  options?: string[];
}

export interface UpdateAttributeInput {
  id: string;
  name?: string;
  slug?: string;
  filterable?: boolean;
  options?: string[] | null;
}

export interface AttributePayload {
  attribute: AttributeDto;
}

export interface MessagePayload {
  message: string;
}

export interface AttributeValueDto {
  value: string;
  productCount: number;
  createdAt: AttributeTimestamp;
  isPreset: boolean;
  sampleProducts: string[];
}

export interface AttributeValuesPayload {
  attributeId: string;
  attributeName: string;
  values: AttributeValueDto[];
  totalValues: number;
  page: number;
  totalPages: number;
}

export interface AttributeValuesQueryInput {
  [key: string]: string | number | undefined;
  attributeId?: string;
  id?: string;
  page?: number;
  limit?: number;
  search?: string;
  sort?: "asc" | "desc" | string;
}

function toAttributesParams(data: AttributesQueryInput): Record<string, string> {
  const params: Record<string, string> = {};
  if (data.page) params.page = String(data.page);
  if (data.limit) params.limit = String(data.limit);
  if (data.search) params.search = data.search;
  if (data.sort) params.sort = data.sort;
  if (data.order) params.order = data.order;
  if (data.trashed) params.trashed = "true";
  return params;
}

function toAttributeValuesParams(
  data: AttributeValuesQueryInput,
): Record<string, string> {
  const params: Record<string, string> = {};
  if (data.page) params.page = String(data.page);
  if (data.limit) params.limit = String(data.limit);
  if (data.search) params.search = data.search;
  if (data.sort) params.sort = data.sort;
  return params;
}

export const getAttributes = createServerFn({ method: "GET" })
  .validator((data: AttributesQueryInput) => data)
  .handler(async ({ data }) => {
    return apiGet<AttributesListPayload>("/attributes", toAttributesParams(data));
  });

export const createAttribute = createServerFn({ method: "POST" })
  .validator((data: CreateAttributeInput) => data)
  .handler(async ({ data }) => {
    return apiPost<AttributePayload>("/attributes", data);
  });

export const updateAttribute = createServerFn({ method: "POST" })
  .validator((data: UpdateAttributeInput) => data)
  .handler(async ({ data }) => {
    const { id, ...body } = data;
    return apiPut<AttributePayload>(`/attributes/${id}`, body);
  });

export const deleteAttribute = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/attributes/${data.id}`);
  });

export const deleteAttributePermanent = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/attributes/${data.id}/permanent`);
  });

export const restoreAttribute = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiPost<MessagePayload>(`/attributes/${data.id}/restore`);
  });

export const bulkDeleteAttributes = createServerFn({ method: "POST" })
  .validator((data: { ids: string[]; permanent?: boolean }) => data)
  .handler(async ({ data }) => {
    return apiPost<void>("/attributes/bulk-delete", data);
  });

export const bulkRestoreAttributes = createServerFn({ method: "POST" })
  .validator((data: { ids: string[] }) => data)
  .handler(async ({ data }) => {
    return apiPost<void>("/attributes/bulk-restore", data);
  });

export const getAttributeValues = createServerFn({ method: "GET" })
  .validator((data: AttributeValuesQueryInput) => data)
  .handler(async ({ data }) => {
    const attributeId = data.attributeId || data.id;
    if (!attributeId) {
      throw new Error("Attribute ID is required");
    }

    return apiGet<AttributeValuesPayload>(
      `/attributes/${attributeId}/values`,
      toAttributeValuesParams(data),
    );
  });

export const renameAttributeValue = createServerFn({ method: "POST" })
  .validator(
    (data: { attributeId: string; oldValue: string; newValue: string }) => data,
  )
  .handler(async ({ data }) => {
    return apiPut<MessagePayload>(`/attributes/${data.attributeId}/values`, {
      oldValue: data.oldValue,
      newValue: data.newValue,
    });
  });

export const addAttributeValue = createServerFn({ method: "POST" })
  .validator((data: { attributeId: string; value: string }) => data)
  .handler(async ({ data }) => {
    return apiPost<Record<string, never>>(`/attributes/${data.attributeId}/values`, {
      value: data.value,
    });
  });

export const removeAttributeValue = createServerFn({ method: "POST" })
  .validator((data: { attributeId: string; value: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/attributes/${data.attributeId}/values`, {
      value: data.value,
    });
  });
