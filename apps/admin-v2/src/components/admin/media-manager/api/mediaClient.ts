import { unixToDate } from "@scalius/shared/timestamps";
import {
  createMediaFolder,
  deleteMediaFolder,
  getMediaFolders,
  getMediaList,
  moveMediaFiles,
  permanentlyDeleteMedia,
  renameMediaFolder,
  restoreMedia,
  trashMedia,
  updateMedia,
  type MediaFileDto,
  type MediaFolderDto,
} from "~/lib/api-functions/media";
import type {
  CursorPagination,
  MediaApiResponse,
  LibraryMediaFile,
  MediaFilterOptions,
  MediaFolder,
} from "../types";

const MEDIA_API = "/api/v1/admin/media";

interface ApiEnvelope<T> {
  success?: boolean;
  data?: T;
  error?: string | { message?: string };
}

export interface MediaUploadSession {
  id: string;
  mediaId: string;
  filename: string;
  kind: "image" | "video";
  mimeType: string;
  size: number;
  expectedParts: number;
  partSize: number;
  state: string;
  version: number;
  expiresAt: string | number;
  uploadedParts?: Array<{ partNumber: number; size: number }>;
}

function date(value: string | number | Date | null | undefined): Date {
  return unixToDate(value) ?? new Date(0);
}

export function toMediaFile(file: MediaFileDto): LibraryMediaFile {
  return {
    id: file.id,
    url: file.url,
    filename: file.filename,
    objectKey: file.objectKey,
    kind: file.kind,
    size: file.size,
    mimeType: file.mimeType,
    altText: file.altText ?? null,
    caption: file.caption ?? null,
    width: file.width ?? null,
    height: file.height ?? null,
    durationMs: file.durationMs ?? null,
    posterMediaId: file.posterMediaId ?? null,
    folderId: file.folderId,
    status: file.status,
    version: file.version,
    createdAt: date(file.createdAt),
    updatedAt: date(file.updatedAt),
    trashedAt: file.trashedAt == null ? null : date(file.trashedAt),
    deletedAt: file.deletedAt == null ? null : date(file.deletedAt),
  };
}

function toFolder(folder: MediaFolderDto): MediaFolder {
  return {
    id: folder.id,
    name: folder.name,
    version: folder.version,
    createdAt: date(folder.createdAt),
    updatedAt: date(folder.updatedAt),
    deletedAt: folder.deletedAt == null ? null : date(folder.deletedAt),
  };
}

async function parseDirectResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  let body: ApiEnvelope<T>;
  try {
    body = (await response.json()) as ApiEnvelope<T>;
  } catch {
    throw new Error(`Media request failed (${response.status}).`);
  }
  if (!response.ok || body.success === false) {
    const message = typeof body.error === "string" ? body.error : body.error?.message;
    throw new Error(message || `Media request failed (${response.status}).`);
  }
  if (body.data === undefined) throw new Error("Media service returned an incomplete response.");
  return body.data;
}

export class MediaApiClient {
  static async fetchFiles(
    cursor: string | undefined,
    limit: number,
    filters: Partial<MediaFilterOptions>,
  ): Promise<MediaApiResponse> {
    const data = await getMediaList({ data: {
      cursor,
      limit,
      search: filters.search,
      folderId: filters.folderId,
      sortBy: filters.sortBy,
      sortOrder: filters.sortOrder,
      kind: filters.kind,
      view: filters.view,
    } });
    return { files: data.files.map(toMediaFile), pagination: data.pagination };
  }

  static async fetchFolders(): Promise<MediaFolder[]> {
    const folders: MediaFolder[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const data = await getMediaFolders({ data: { cursor, limit: 100 } });
      folders.push(...data.folders.map(toFolder));
      if (!data.pagination.hasMore || !data.pagination.nextCursor) break;
      if (page === 19) {
        throw new Error("This library has more than 2,000 folders. Consolidate folders before managing them here.");
      }
      cursor = data.pagination.nextCursor;
    }
    return folders;
  }

  static async createFolder(name: string): Promise<MediaFolder> {
    const data = await createMediaFolder({ data: { name } });
    return toFolder(data.folder);
  }

  static async renameFolder(folder: MediaFolder, name: string): Promise<MediaFolder> {
    const data = await renameMediaFolder({ data: { folderId: folder.id, name, expectedVersion: folder.version } });
    return toFolder(data.folder);
  }

  static async deleteFolder(folder: MediaFolder): Promise<void> {
    await deleteMediaFolder({ data: { folderId: folder.id, expectedVersion: folder.version } });
  }

  static async updateFile(file: LibraryMediaFile, updates: { filename?: string; altText?: string | null; caption?: string | null; width?: number | null; height?: number | null; durationMs?: number | null; posterMediaId?: string | null; folderId?: string | null }): Promise<LibraryMediaFile> {
    const data = await updateMedia({ data: { fileId: file.id, update: { expectedVersion: file.version, ...updates } } });
    return toMediaFile(data.file);
  }

  static async trashFile(file: LibraryMediaFile): Promise<LibraryMediaFile> {
    const data = await trashMedia({ data: { fileId: file.id, expectedVersion: file.version } });
    return toMediaFile(data.file);
  }

  static async restoreFile(file: LibraryMediaFile): Promise<LibraryMediaFile> {
    const data = await restoreMedia({ data: { fileId: file.id, expectedVersion: file.version } });
    return toMediaFile(data.file);
  }

  static async permanentlyDeleteFile(file: LibraryMediaFile): Promise<void> {
    await permanentlyDeleteMedia({ data: { fileId: file.id, expectedVersion: file.version } });
  }

  static async moveFiles(files: LibraryMediaFile[], folderId: string | null): Promise<number> {
    const data = await moveMediaFiles({ data: {
      items: files.map((file) => ({ id: file.id, expectedVersion: file.version })),
      folderId,
    } });
    return data.movedCount;
  }

  static async initiateUpload(input: { filename: string; mimeType: string; size: number; folderId: string | null }): Promise<MediaUploadSession> {
    const response = await fetch(`${MEDIA_API}/uploads`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return (await parseDirectResponse<{ session: MediaUploadSession }>(response)).session;
  }

  static async getUpload(sessionId: string): Promise<MediaUploadSession> {
    const response = await fetch(`${MEDIA_API}/uploads/${encodeURIComponent(sessionId)}`, {
      credentials: "same-origin",
    });
    return (await parseDirectResponse<{ session: MediaUploadSession }>(response)).session;
  }

  static async uploadPart(sessionId: string, partNumber: number, blob: Blob, signal?: AbortSignal): Promise<void> {
    const response = await fetch(`${MEDIA_API}/uploads/${encodeURIComponent(sessionId)}/parts/${partNumber}`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/octet-stream" },
      body: blob,
      signal,
    });
    await parseDirectResponse(response);
  }

  static async completeUpload(sessionId: string): Promise<LibraryMediaFile> {
    const response = await fetch(`${MEDIA_API}/uploads/${encodeURIComponent(sessionId)}/complete`, {
      method: "POST",
      credentials: "same-origin",
    });
    const data = await parseDirectResponse<{ file: MediaFileDto }>(response);
    return toMediaFile(data.file);
  }

  static async abortUpload(sessionId: string): Promise<void> {
    const response = await fetch(`${MEDIA_API}/uploads/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      credentials: "same-origin",
    });
    await parseDirectResponse(response);
  }
}

export type { CursorPagination };
