import { createServerFn } from "@tanstack/react-start";
import { apiDelete, apiGet, apiPost, apiPut } from "../api.server";

export type MediaTimestamp = string | number;

export interface MediaFileDto {
  id: string;
  filename: string;
  url: string;
  size: number;
  mimeType: string;
  altText?: string | null;
  width?: number | null;
  height?: number | null;
  folderId?: string | null;
  createdAt: MediaTimestamp;
  updatedAt?: MediaTimestamp;
  deletedAt?: MediaTimestamp | null;
}

export interface MediaFolderDto {
  id: string;
  name: string;
  parentId?: string | null;
  createdAt: MediaTimestamp;
  updatedAt?: MediaTimestamp;
  deletedAt?: MediaTimestamp | null;
}

export interface MediaPagination {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface MediaListPayload {
  files: MediaFileDto[];
  pagination: MediaPagination;
}

export interface MediaFoldersPayload {
  folders: MediaFolderDto[];
}

export interface MediaListQueryInput {
  [key: string]: string | number | null | undefined;
  page?: number;
  limit?: number;
  search?: string;
  folderId?: string | null;
  mimeType?: string;
  type?: string;
  fileType?: string;
  sortBy?: "createdAt" | "filename" | "size" | string;
  sortOrder?: "asc" | "desc" | string;
}

export interface UpdateMediaInput {
  fileId: string;
  update: {
    filename?: string;
    altText?: string | null;
    folderId?: string | null;
  };
}

export interface MediaFilePayload {
  file: MediaFileDto;
}

export interface CreateMediaFolderInput {
  name: string;
  parentId?: string | null;
}

export interface MediaFolderPayload {
  folder: MediaFolderDto;
}

export interface RenameMediaFolderInput {
  folderId: string;
  name: string;
}

export interface MoveMediaFilesInput {
  fileIds: string[];
  folderId?: string | null;
}

export interface MoveMediaFilesPayload {
  message: string;
  movedCount: number;
}

function toMediaListParams(data: MediaListQueryInput): Record<string, string> {
  const params: Record<string, string> = {};
  if (data.page) params.page = String(data.page);
  if (data.limit) params.limit = String(data.limit);
  if (data.search) params.search = data.search;
  if (data.folderId !== undefined) params.folderId = data.folderId ?? "root";

  const mimeType = data.mimeType ?? data.fileType ?? data.type;
  if (mimeType) params.mimeType = mimeType;

  if (data.sortBy) params.sortBy = data.sortBy;
  if (data.sortOrder) params.sortOrder = data.sortOrder;
  return params;
}

export const getMediaList = createServerFn({ method: "GET" })
  .validator((data: MediaListQueryInput) => data)
  .handler(async ({ data }) => {
    return apiGet<MediaListPayload>("/media", toMediaListParams(data));
  });

export const deleteMedia = createServerFn({ method: "POST" })
  .validator((data: { fileId: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/media/${data.fileId}`);
  });

export const updateMedia = createServerFn({ method: "POST" })
  .validator((data: UpdateMediaInput) => data)
  .handler(async ({ data }) => {
    return apiPut<MediaFilePayload>(`/media/${data.fileId}`, data.update);
  });

export const getMediaFolders = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<MediaFoldersPayload>("/media/folders");
  },
);

export const createMediaFolder = createServerFn({ method: "POST" })
  .validator((data: CreateMediaFolderInput) => data)
  .handler(async ({ data }) => {
    return apiPost<MediaFolderPayload>("/media/folders", data);
  });

export const renameMediaFolder = createServerFn({ method: "POST" })
  .validator((data: RenameMediaFolderInput) => data)
  .handler(async ({ data }) => {
    return apiPut<MediaFolderPayload>(`/media/folders/${data.folderId}`, {
      name: data.name,
    });
  });

export const moveMediaFiles = createServerFn({ method: "POST" })
  .validator((data: MoveMediaFilesInput) => data)
  .handler(async ({ data }) => {
    return apiPost<MoveMediaFilesPayload>("/media/move", {
      fileIds: data.fileIds,
      folderId: data.folderId ?? null,
    });
  });

export const deleteMediaFolder = createServerFn({ method: "POST" })
  .validator((data: { folderId: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/media/folders/${data.folderId}`);
  });
