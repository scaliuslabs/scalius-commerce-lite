import { createServerFn } from "@tanstack/react-start";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from "../api.server";

export type MediaTimestamp = string | number;
export type MediaKindDto = "image" | "video";
export type MediaViewDto = "ready" | "trash";

export interface MediaFileDto {
  id: string;
  filename: string;
  url: string;
  objectKey: string;
  kind: MediaKindDto;
  size: number;
  mimeType: string;
  altText?: string | null;
  caption?: string | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  posterMediaId?: string | null;
  posterUrl: string | null;
  folderId: string | null;
  status: "ready" | "trashed" | "deleting" | "deleted";
  version: number;
  createdAt: MediaTimestamp;
  updatedAt: MediaTimestamp;
  trashedAt?: MediaTimestamp | null;
  deletedAt?: MediaTimestamp | null;
}

export interface MediaFolderDto {
  id: string;
  name: string;
  version: number;
  createdAt: MediaTimestamp;
  updatedAt: MediaTimestamp;
  deletedAt?: MediaTimestamp | null;
}

export interface CursorPaginationDto {
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface MediaListPayload {
  files: MediaFileDto[];
  pagination: CursorPaginationDto;
}

export interface MediaFoldersPayload {
  folders: MediaFolderDto[];
  pagination: CursorPaginationDto;
}

export interface MediaListQueryInput {
  cursor?: string;
  limit?: number;
  search?: string;
  folderId?: string | null;
  kind?: MediaKindDto;
  view?: MediaViewDto;
  sortBy?: "createdAt" | "filename" | "size";
  sortOrder?: "asc" | "desc";
}

export interface UpdateMediaInput {
  fileId: string;
  update: {
    expectedVersion: number;
    filename?: string;
    altText?: string | null;
    caption?: string | null;
    width?: number | null;
    height?: number | null;
    durationMs?: number | null;
    posterMediaId?: string | null;
    folderId?: string | null;
  };
}

export interface MediaFilePayload { file: MediaFileDto }
export interface MediaFolderPayload { folder: MediaFolderDto }

function listParams(data: MediaListQueryInput): Record<string, string> {
  const params: Record<string, string> = {};
  if (data.cursor) params.cursor = data.cursor;
  if (data.limit) params.limit = String(data.limit);
  if (data.search?.trim()) params.search = data.search.trim();
  if (data.folderId !== undefined) params.folderId = data.folderId ?? "root";
  if (data.kind) params.kind = data.kind;
  if (data.view) params.view = data.view;
  if (data.sortBy) params.sortBy = data.sortBy;
  if (data.sortOrder) params.sortOrder = data.sortOrder;
  return params;
}

export const getMediaList = createServerFn({ method: "GET" })
  .validator((data: MediaListQueryInput) => data)
  .handler(async ({ data }) => apiGet<MediaListPayload>("/media", listParams(data)));

export const updateMedia = createServerFn({ method: "POST" })
  .validator((data: UpdateMediaInput) => data)
  .handler(async ({ data }) => apiPatch<MediaFilePayload>(`/media/${data.fileId}`, data.update));

export const trashMedia = createServerFn({ method: "POST" })
  .validator((data: { fileId: string; expectedVersion: number }) => data)
  .handler(async ({ data }) => apiPost<MediaFilePayload>(`/media/${data.fileId}/trash`, { expectedVersion: data.expectedVersion }));

export const restoreMedia = createServerFn({ method: "POST" })
  .validator((data: { fileId: string; expectedVersion: number }) => data)
  .handler(async ({ data }) => apiPost<MediaFilePayload>(`/media/${data.fileId}/restore`, { expectedVersion: data.expectedVersion }));

export const permanentlyDeleteMedia = createServerFn({ method: "POST" })
  .validator((data: { fileId: string; expectedVersion: number }) => data)
  .handler(async ({ data }) => apiDelete(`/media/${data.fileId}/permanent?expectedVersion=${encodeURIComponent(String(data.expectedVersion))}`));

export const moveMediaFiles = createServerFn({ method: "POST" })
  .validator((data: { items: Array<{ id: string; expectedVersion: number }>; folderId?: string | null }) => data)
  .handler(async ({ data }) => apiPost<{ movedCount: number }>("/media/move", { items: data.items, folderId: data.folderId ?? null }));

export const getMediaFolders = createServerFn({ method: "GET" })
  .validator((data: { cursor?: string; limit?: number }) => data)
  .handler(async ({ data }) => apiGet<MediaFoldersPayload>("/media/folders", {
    ...(data.cursor ? { cursor: data.cursor } : {}),
    limit: String(data.limit ?? 100),
  }));

export const createMediaFolder = createServerFn({ method: "POST" })
  .validator((data: { name: string }) => data)
  .handler(async ({ data }) => apiPost<MediaFolderPayload>("/media/folders", data));

export const renameMediaFolder = createServerFn({ method: "POST" })
  .validator((data: { folderId: string; name: string; expectedVersion: number }) => data)
  .handler(async ({ data }) => apiPut<MediaFolderPayload>(`/media/folders/${data.folderId}`, { name: data.name, expectedVersion: data.expectedVersion }));

export const deleteMediaFolder = createServerFn({ method: "POST" })
  .validator((data: { folderId: string; expectedVersion: number }) => data)
  .handler(async ({ data }) => apiDelete(`/media/folders/${data.folderId}?expectedVersion=${encodeURIComponent(String(data.expectedVersion))}`));
