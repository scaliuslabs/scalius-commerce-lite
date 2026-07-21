import { createServerFn } from "@tanstack/react-start";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from "../api.server";
import type { CategoryStatus } from "@scalius/shared/category-publication";

type Timestamp = string | number;
type NullableTimestamp = Timestamp | null;

export interface CategoryImageInput {
  id: string;
  url: string;
  filename: string;
  size: number;
  createdAt: string;
  updatedAt?: string;
  mimeType?: string;
  altText?: string | null;
  width?: number | null;
  height?: number | null;
  folderId?: string | null;
}

export interface CategoryListItemDto {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  canonicalPath: string | null;
  noIndex: boolean;
  excludeFromSitemap: boolean;
  createdAt: NullableTimestamp;
  updatedAt: NullableTimestamp;
  deletedAt: NullableTimestamp;
  productCount: number;
  status: CategoryStatus;
  revision: number;
  publishReady: boolean;
}

export interface CategoryPublishReadiness {
  ready: boolean;
  eligibleProductCount: number;
  blockers: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
}

export interface CategoryDetailDto {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  content: string | null;
  imageUrl: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  canonicalPath: string | null;
  noIndex: boolean;
  excludeFromSitemap: boolean;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
  status: CategoryStatus;
  revision: number;
  publishReadiness: CategoryPublishReadiness;
}

export interface PaginationPayload {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface CategoriesListPayload {
  categories: CategoryListItemDto[];
  pagination: PaginationPayload;
}

export interface CategoriesQueryInput {
  [key: string]: string | number | boolean | undefined;
  page?: number;
  limit?: number;
  search?: string;
  sort?: string;
  order?: string;
  showTrashed?: boolean;
  trashed?: boolean;
  status?: CategoryStatus;
}

export interface CreateCategoryInput {
  name: string;
  description: string | null;
  content: string | null;
  slug: string;
  metaTitle: string | null;
  metaDescription: string | null;
  canonicalPath: string | null;
  noIndex: boolean;
  excludeFromSitemap: boolean;
  image: CategoryImageInput | null;
}

export type UpdateCategoryInput = {
  id: string;
  expectedRevision: number;
  status: CategoryStatus;
} & CreateCategoryInput;

export interface CategoryRevisionClaim {
  id: string;
  expectedRevision: number;
}

export interface CategoryMutationResult {
  revision: number;
  status: CategoryStatus;
}

export interface CategoryCreateResult extends CategoryMutationResult {
  id: string;
}

export interface MessagePayload {
  message?: string;
}

export interface CategoryFormOptionsPayload {
  categories: Array<{ id: string; name: string; status: CategoryStatus }>;
}

function toCategoriesParams(input: CategoriesQueryInput): Record<string, string> {
  const params: Record<string, string> = {};
  if (input.page) params.page = String(input.page);
  if (input.limit) params.limit = String(input.limit);
  if (input.search) params.search = input.search;
  if (input.sort) params.sort = input.sort;
  if (input.order) params.order = input.order;
  if (input.showTrashed || input.trashed) params.trashed = "true";
  if (input.status) params.status = input.status;
  return params;
}

export const getCategories = createServerFn({ method: "GET" })
  .validator((data: CategoriesQueryInput) => data)
  .handler(async ({ data }): Promise<CategoriesListPayload> => {
    return apiGet<CategoriesListPayload>("/categories", toCategoriesParams(data));
  });

export const getCategory = createServerFn({ method: "GET" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<CategoryDetailDto> => {
    return apiGet<CategoryDetailDto>(`/categories/${data.id}`);
  });

export const getCategoryFormOptions = createServerFn({
  method: "GET",
}).handler(async (): Promise<CategoryFormOptionsPayload> => {
  return apiGet<CategoryFormOptionsPayload>("/categories/form-options");
});

export const createCategory = createServerFn({ method: "POST" })
  .validator((data: CreateCategoryInput) => data)
  .handler(async ({ data }): Promise<CategoryCreateResult> => {
    return apiPost<CategoryCreateResult>("/categories", data);
  });

export const updateCategory = createServerFn({ method: "POST" })
  .validator((data: UpdateCategoryInput) => data)
  .handler(async ({ data }): Promise<CategoryMutationResult> => {
    const { id, ...body } = data;
    return apiPut<CategoryMutationResult>(`/categories/${id}`, body);
  });

export const updateCategoryStatus = createServerFn({ method: "POST" })
  .validator((data: CategoryRevisionClaim & { status: CategoryStatus }) => data)
  .handler(async ({ data }): Promise<CategoryMutationResult> => {
    const { id, ...body } = data;
    return apiPatch<CategoryMutationResult>(`/categories/${id}/status`, body);
  });

export const deleteCategory = createServerFn({ method: "POST" })
  .validator((data: CategoryRevisionClaim) => data)
  .handler(async ({ data }): Promise<void> => {
    return apiDelete(`/categories/${data.id}`, {
      expectedRevision: data.expectedRevision,
    });
  });

export const deleteCategoryPermanent = createServerFn({ method: "POST" })
  .validator((data: CategoryRevisionClaim) => data)
  .handler(async ({ data }): Promise<void> => {
    return apiDelete(`/categories/${data.id}/permanent`, {
      expectedRevision: data.expectedRevision,
    });
  });

export const restoreCategory = createServerFn({ method: "POST" })
  .validator((data: CategoryRevisionClaim) => data)
  .handler(async ({ data }): Promise<MessagePayload> => {
    return apiPost<MessagePayload>(`/categories/${data.id}/restore`, {
      expectedRevision: data.expectedRevision,
    });
  });

export const bulkDeleteCategories = createServerFn({ method: "POST" })
  .validator((data: { categories: CategoryRevisionClaim[]; permanent?: boolean }) => data)
  .handler(async ({ data }): Promise<void> => {
    return apiPost<void>("/categories/bulk-delete", data);
  });

export const bulkRestoreCategories = createServerFn({ method: "POST" })
  .validator((data: { categories: CategoryRevisionClaim[] }) => data)
  .handler(async ({ data }): Promise<void> => {
    return apiPost<void>("/categories/bulk-restore", data);
  });
