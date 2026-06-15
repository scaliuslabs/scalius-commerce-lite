import { createServerFn } from "@tanstack/react-start";
import { apiDelete, apiGet, apiPost, apiPut } from "../api.server";

type Timestamp = string | number;
type NullableTimestamp = Timestamp | null;

export type CollectionType = "manual" | "dynamic";

export interface CollectionConfigInput {
  categoryIds?: string[];
  productIds?: string[];
  featuredProductId?: string;
  maxProducts?: number;
  title?: string;
  subtitle?: string;
}

export interface CollectionDto {
  id: string;
  name: string;
  type: CollectionType;
  config: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: NullableTimestamp;
  updatedAt: NullableTimestamp;
  deletedAt: NullableTimestamp;
}

export interface PaginationPayload {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface CollectionsListPayload {
  collections: CollectionDto[];
  pagination: PaginationPayload;
}

export interface CollectionPickerItemDto {
  id: string;
  name: string;
  type: CollectionType;
}

export interface CollectionsByIdsInput {
  ids: string[];
}

export interface CollectionsByIdsPayload {
  collections: CollectionPickerItemDto[];
}

export interface CollectionsQueryInput {
  [key: string]: string | number | boolean | undefined;
  page?: number;
  limit?: number;
  search?: string;
  sort?: string;
  order?: string;
  showTrashed?: boolean;
  trashed?: boolean;
}

export interface CreateCollectionInput {
  name: string;
  type: CollectionType;
  isActive: boolean;
  config: CollectionConfigInput;
}

export type UpdateCollectionInput = { id: string } & Partial<CreateCollectionInput>;

export interface CollectionFormOptionsPayload {
  categories: Array<{ id: string; name: string }>;
  products: Array<{
    id: string;
    name: string;
    price: number;
    categoryId?: string | null;
  }>;
}

export interface CollectionCategoryOptionsPayload {
  categories: Array<{ id: string; name: string }>;
}

export interface MessagePayload {
  message: string;
}

function toCollectionsParams(input: CollectionsQueryInput): Record<string, string> {
  const params: Record<string, string> = {};
  if (input.page) params.page = String(input.page);
  if (input.limit) params.limit = String(input.limit);
  if (input.search) params.search = input.search;
  if (input.sort) params.sort = input.sort;
  if (input.order) params.order = input.order;
  if (input.showTrashed || input.trashed) params.trashed = "true";
  return params;
}

export const getCollections = createServerFn({ method: "GET" })
  .validator((data: CollectionsQueryInput) => data)
  .handler(async ({ data }): Promise<CollectionsListPayload> => {
    return apiGet<CollectionsListPayload>("/collections", toCollectionsParams(data));
  });

export const getCollectionsByIds = createServerFn({ method: "GET" })
  .validator((data: CollectionsByIdsInput) => data)
  .handler(async ({ data }): Promise<CollectionsByIdsPayload> => {
    const ids = Array.from(new Set(data.ids.map((id) => id.trim()).filter(Boolean)));
    if (ids.length === 0) return { collections: [] };
    return apiGet<CollectionsByIdsPayload>("/collections/by-ids", {
      ids: ids.join(","),
    });
  });

export const getCollection = createServerFn({ method: "GET" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<CollectionDto> => {
    return apiGet<CollectionDto>(`/collections/${data.id}`);
  });

export const getCollectionCategoryOptions = createServerFn({
  method: "GET",
}).handler(async (): Promise<CollectionCategoryOptionsPayload> => {
  return apiGet<CollectionCategoryOptionsPayload>("/collections/category-options");
});

export const getCollectionFormOptions = createServerFn({
  method: "GET",
}).handler(async (): Promise<CollectionFormOptionsPayload> => {
  return apiGet<CollectionFormOptionsPayload>("/collections/form-options");
});

export const createCollection = createServerFn({ method: "POST" })
  .validator((data: CreateCollectionInput) => data)
  .handler(async ({ data }): Promise<CollectionDto> => {
    return apiPost<CollectionDto>("/collections", data);
  });

export const updateCollection = createServerFn({ method: "POST" })
  .validator((data: UpdateCollectionInput) => data)
  .handler(async ({ data }): Promise<CollectionDto> => {
    const { id, ...body } = data;
    return apiPut<CollectionDto>(`/collections/${id}`, body);
  });

export const deleteCollection = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<void> => {
    return apiDelete(`/collections/${data.id}`);
  });

export const deleteCollectionPermanent = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<void> => {
    return apiDelete(`/collections/${data.id}/permanent`);
  });

export const restoreCollection = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<MessagePayload> => {
    return apiPost<MessagePayload>(`/collections/${data.id}/restore`);
  });

export const reorderCollections = createServerFn({ method: "POST" })
  .validator((data: { items: { id: string; sortOrder: number }[] }) => data)
  .handler(async ({ data }): Promise<Record<string, never>> => {
    return apiPost<Record<string, never>>("/collections/reorder", data);
  });

export const bulkDeleteCollections = createServerFn({ method: "POST" })
  .validator((data: { collectionIds: string[]; permanent?: boolean }) => data)
  .handler(async ({ data }): Promise<void> => {
    return apiPost<void>("/collections/bulk-delete", data);
  });

export const bulkRestoreCollections = createServerFn({ method: "POST" })
  .validator((data: { ids: string[] }) => data)
  .handler(async ({ data }): Promise<void> => {
    return apiPost<void>("/collections/bulk-restore", data);
  });

export const bulkActivateCollections = createServerFn({ method: "POST" })
  .validator((data: { ids: string[] }) => data)
  .handler(async ({ data }): Promise<void> => {
    return apiPost<void>("/collections/bulk-activate", data);
  });

export const bulkDeactivateCollections = createServerFn({ method: "POST" })
  .validator((data: { ids: string[] }) => data)
  .handler(async ({ data }): Promise<void> => {
    return apiPost<void>("/collections/bulk-deactivate", data);
  });
