import { createServerFn } from "@tanstack/react-start";
import { apiDelete, apiGet, apiPost, apiPut } from "../api.server";

type Timestamp = string | number;
type NullableTimestamp = Timestamp | null;

export interface PageFeaturedImageDto {
  id: string;
  url: string;
  filename: string;
  size: number;
  mimeType?: string;
  altText?: string | null;
  width?: number | null;
  height?: number | null;
  folderId?: string | null;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface PageDto {
  id: string;
  title: string;
  slug: string;
  content: string;
  metaTitle: string | null;
  metaDescription: string | null;
  canonicalPath: string | null;
  noIndex: boolean;
  excludeFromSitemap: boolean;
  isPublished: boolean;
  hideHeader: boolean;
  hideFooter: boolean;
  hideTitle: boolean;
  featuredImage?: PageFeaturedImageDto | null;
  publishedAt?: NullableTimestamp;
  sortOrder: number;
  revision: number;
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

export interface PagesListPayload {
  pages: PageDto[];
  pagination: PaginationPayload;
}

export interface PagesQueryInput {
  [key: string]: string | number | boolean | undefined;
  page?: number;
  limit?: number;
  search?: string;
  sort?: string;
  order?: string;
  showTrashed?: boolean;
  trashed?: boolean;
  status?: "draft" | "scheduled" | "published";
}

export interface CreatePageInput {
  title: string;
  slug: string;
  content: string;
  metaTitle: string | null;
  metaDescription: string | null;
  canonicalPath: string | null;
  noIndex: boolean;
  excludeFromSitemap: boolean;
  isPublished: boolean;
  publishedAt?: string | null;
  hideHeader: boolean;
  hideFooter: boolean;
  hideTitle: boolean;
  featuredImage?: PageFeaturedImageDto | null;
}

export type UpdatePageInput = {
  id: string;
  expectedRevision: number;
} & Partial<CreatePageInput>;

export interface PageRevisionClaim {
  id: string;
  expectedRevision: number;
}

export interface PageIdPayload {
  id: string;
  revision: number;
}

export interface PageMutationPayload {
  revision: number;
}

export interface MessagePayload {
  message: string;
}

function toPagesParams(input: PagesQueryInput): Record<string, string> {
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

export const getPages = createServerFn({ method: "GET" })
  .validator((data: PagesQueryInput) => data)
  .handler(async ({ data }): Promise<PagesListPayload> => {
    return apiGet<PagesListPayload>("/pages", toPagesParams(data));
  });

export const getPage = createServerFn({ method: "GET" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<PageDto> => {
    return apiGet<PageDto>(`/pages/${data.id}`);
  });

export const createPage = createServerFn({ method: "POST" })
  .validator((data: CreatePageInput) => data)
  .handler(async ({ data }): Promise<PageIdPayload> => {
    return apiPost<PageIdPayload>("/pages", data);
  });

export const updatePage = createServerFn({ method: "POST" })
  .validator((data: UpdatePageInput) => data)
  .handler(async ({ data }): Promise<PageMutationPayload> => {
    const { id, ...body } = data;
    return apiPut<PageMutationPayload>(`/pages/${id}`, body);
  });

export const deletePage = createServerFn({ method: "POST" })
  .validator((data: PageRevisionClaim) => data)
  .handler(async ({ data }): Promise<void> => {
    return apiDelete(`/pages/${data.id}`, {
      expectedRevision: data.expectedRevision,
    });
  });

export const permanentDeletePage = createServerFn({ method: "POST" })
  .validator((data: PageRevisionClaim) => data)
  .handler(async ({ data }): Promise<void> => {
    return apiDelete(`/pages/${data.id}/permanent`, {
      expectedRevision: data.expectedRevision,
    });
  });

export const restorePage = createServerFn({ method: "POST" })
  .validator((data: PageRevisionClaim) => data)
  .handler(async ({ data }): Promise<MessagePayload> => {
    return apiPost<MessagePayload>(`/pages/${data.id}/restore`, {
      expectedRevision: data.expectedRevision,
    });
  });

export const bulkDeletePages = createServerFn({ method: "POST" })
  .validator((data: { pages: PageRevisionClaim[]; permanent?: boolean }) => data)
  .handler(async ({ data }): Promise<void> => {
    return apiPost("/pages/bulk-delete", data);
  });

export const bulkRestorePages = createServerFn({ method: "POST" })
  .validator((data: { pages: PageRevisionClaim[] }) => data)
  .handler(async ({ data }): Promise<void> => {
    return apiPost("/pages/bulk-restore", data);
  });

export const bulkPublishPages = createServerFn({ method: "POST" })
  .validator((data: { pages: PageRevisionClaim[] }) => data)
  .handler(async ({ data }): Promise<void> => {
    return apiPost("/pages/bulk-publish", data);
  });

export const bulkUnpublishPages = createServerFn({ method: "POST" })
  .validator((data: { pages: PageRevisionClaim[] }) => data)
  .handler(async ({ data }): Promise<void> => {
    return apiPost("/pages/bulk-unpublish", data);
  });
