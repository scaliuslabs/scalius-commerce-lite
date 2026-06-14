import { createServerFn } from "@tanstack/react-start";
import { apiDelete, apiGet, apiPost, apiPut } from "../api.server";

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
  createdAt: NullableTimestamp;
  updatedAt: NullableTimestamp;
  deletedAt: NullableTimestamp;
  productCount: number;
}

export interface CategoryDetailDto {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  createdAt: number;
  updatedAt: number;
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
}

export interface CreateCategoryInput {
  name: string;
  description: string | null;
  slug: string;
  metaTitle: string | null;
  metaDescription: string | null;
  image: CategoryImageInput | null;
}

export type UpdateCategoryInput = { id: string } & CreateCategoryInput;

export interface CategoryIdPayload {
  id: string;
}

export interface MessagePayload {
  message?: string;
}

export interface CategoryFormOptionsPayload {
  categories: Array<{ id: string; name: string }>;
}

function toCategoriesParams(input: CategoriesQueryInput): Record<string, string> {
  const params: Record<string, string> = {};
  if (input.page) params.page = String(input.page);
  if (input.limit) params.limit = String(input.limit);
  if (input.search) params.search = input.search;
  if (input.sort) params.sort = input.sort;
  if (input.order) params.order = input.order;
  if (input.showTrashed || input.trashed) params.trashed = "true";
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
  .handler(async ({ data }): Promise<CategoryIdPayload> => {
    return apiPost<CategoryIdPayload>("/categories", data);
  });

export const updateCategory = createServerFn({ method: "POST" })
  .validator((data: UpdateCategoryInput) => data)
  .handler(async ({ data }): Promise<Record<string, never>> => {
    const { id, ...body } = data;
    return apiPut<Record<string, never>>(`/categories/${id}`, body);
  });

export const deleteCategory = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<void> => {
    return apiDelete(`/categories/${data.id}`);
  });

export const deleteCategoryPermanent = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<void> => {
    return apiDelete(`/categories/${data.id}/permanent`);
  });

export const restoreCategory = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<MessagePayload> => {
    return apiPost<MessagePayload>(`/categories/${data.id}/restore`);
  });

export const bulkDeleteCategories = createServerFn({ method: "POST" })
  .validator((data: { categoryIds: string[]; permanent?: boolean }) => data)
  .handler(async ({ data }): Promise<void> => {
    return apiPost<void>("/categories/bulk-delete", data);
  });

export const bulkRestoreCategories = createServerFn({ method: "POST" })
  .validator((data: { categoryIds: string[] }) => data)
  .handler(async ({ data }): Promise<void> => {
    return apiPost<void>("/categories/bulk-restore", data);
  });
