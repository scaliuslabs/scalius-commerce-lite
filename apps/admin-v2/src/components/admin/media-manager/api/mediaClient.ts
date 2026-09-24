import { unixToDate } from "@scalius/shared/timestamps";
import {
  deleteApiV1AdminMediaByIdPermanent,
  deleteApiV1AdminMediaFoldersById,
  deleteApiV1AdminMediaUploadsById,
  getApiV1AdminMedia,
  getApiV1AdminMediaFolders,
  getApiV1AdminMediaUploadsById,
  patchApiV1AdminMediaById,
  postApiV1AdminMediaByIdRestore,
  postApiV1AdminMediaByIdTrash,
  postApiV1AdminMediaFolders,
  postApiV1AdminMediaMove,
  postApiV1AdminMediaUploads,
  postApiV1AdminMediaUploadsByIdComplete,
  putApiV1AdminMediaFoldersById,
} from "@scalius/api-client/sdk";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { apiData, type ApiBody, type ApiResult } from "~/lib/api";
import type {
  CursorPagination,
  MediaApiResponse,
  LibraryMediaFile,
  MediaFilterOptions,
  MediaFolder,
} from "../types";

import { withDashboardBasePath } from "~/lib/dashboard-base-path";
import { mediaText } from "~/i18n/media";
import type { EncodedMediaVariants } from "../utils/media-variants";

/** Same-origin proxy path, below the runtime dashboard base path. */
const MEDIA_API = withDashboardBasePath("/api/v1/admin/media");

interface ApiEnvelope<T> {
  success?: boolean;
  data?: T;
}

export type MediaFileDto = ApiResult<typeof getApiV1AdminMedia>["files"][number];
type MediaFolderDto = ApiResult<typeof getApiV1AdminMediaFolders>["folders"][number];
export type MediaUploadSession = ApiResult<typeof getApiV1AdminMediaUploadsById>["session"];

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
    posterUrl: file.posterUrl,
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

// Binary uploads (parts, renditions, originals) stay on raw fetch: the SDK
// transport sends JSON text bodies only.
async function parseDirectResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const failed = () => new AdminApiResponseError(mediaText("serverError"), response.ok ? 502 : response.status);
  const body = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;
  if (!response.ok || !body || body.success === false || body.data === undefined) throw failed();
  return body.data;
}

export class MediaApiClient {
  static async fetchFiles(
    cursor: string | undefined,
    limit: number,
    filters: Partial<MediaFilterOptions>,
  ): Promise<MediaApiResponse> {
    const data = await apiData(getApiV1AdminMedia({ query: {
      cursor,
      limit,
      search: filters.search?.trim() || undefined,
      folderId: filters.folderId === undefined ? undefined : filters.folderId ?? "root",
      sortBy: filters.sortBy,
      sortOrder: filters.sortOrder,
      kind: filters.kind,
      view: filters.view,
    } }));
    return { files: data.files.map(toMediaFile), pagination: data.pagination };
  }

  static async fetchFolders(): Promise<MediaFolder[]> {
    const folders: MediaFolder[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const data = await apiData(getApiV1AdminMediaFolders({ query: { cursor, limit: 100 } }));
      folders.push(...data.folders.map(toFolder));
      if (!data.pagination.hasMore || !data.pagination.nextCursor) break;
      if (page === 19) {
        throw new Error(mediaText("tooManyFolders"));
      }
      cursor = data.pagination.nextCursor;
    }
    return folders;
  }

  static async createFolder(name: string): Promise<MediaFolder> {
    const data = await apiData(postApiV1AdminMediaFolders({ body: { name } }));
    return toFolder(data.folder);
  }

  static async renameFolder(folder: MediaFolder, name: string): Promise<MediaFolder> {
    const data = await apiData(putApiV1AdminMediaFoldersById({
      path: { id: folder.id },
      body: { name, expectedVersion: folder.version },
    }));
    return toFolder(data.folder);
  }

  static async deleteFolder(folder: MediaFolder): Promise<void> {
    await apiData(deleteApiV1AdminMediaFoldersById({
      path: { id: folder.id },
      query: { expectedVersion: folder.version },
    }));
  }

  static async updateFile(
    file: LibraryMediaFile,
    updates: Omit<ApiBody<typeof patchApiV1AdminMediaById>, "expectedVersion">,
  ): Promise<LibraryMediaFile> {
    const data = await apiData(patchApiV1AdminMediaById({
      path: { id: file.id },
      body: { expectedVersion: file.version, ...updates },
    }));
    return toMediaFile(data.file);
  }

  static async trashFile(file: LibraryMediaFile): Promise<LibraryMediaFile> {
    const data = await apiData(postApiV1AdminMediaByIdTrash({
      path: { id: file.id },
      body: { expectedVersion: file.version },
    }));
    return toMediaFile(data.file);
  }

  static async restoreFile(file: LibraryMediaFile): Promise<LibraryMediaFile> {
    const data = await apiData(postApiV1AdminMediaByIdRestore({
      path: { id: file.id },
      body: { expectedVersion: file.version },
    }));
    return toMediaFile(data.file);
  }

  static async permanentlyDeleteFile(file: LibraryMediaFile): Promise<void> {
    await apiData(deleteApiV1AdminMediaByIdPermanent({
      path: { id: file.id },
      query: { expectedVersion: file.version },
    }));
  }

  static async moveFiles(files: LibraryMediaFile[], folderId: string | null): Promise<number> {
    const data = await apiData(postApiV1AdminMediaMove({ body: {
      items: files.map((file) => ({ id: file.id, expectedVersion: file.version })),
      folderId,
    } }));
    return data.movedCount;
  }

  static async initiateUpload(input: ApiBody<typeof postApiV1AdminMediaUploads>): Promise<MediaUploadSession> {
    return (await apiData(postApiV1AdminMediaUploads({ body: input }))).session;
  }

  static async getUpload(sessionId: string): Promise<MediaUploadSession> {
    return (await apiData(getApiV1AdminMediaUploadsById({ path: { id: sessionId } }))).session;
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

  /** `client`: this browser uploads the renditions itself; `server`: the API generates them. */
  static async completeUpload(sessionId: string, variants: "client" | "server"): Promise<LibraryMediaFile> {
    const data = await apiData(postApiV1AdminMediaUploadsByIdComplete({
      path: { id: sessionId },
      query: { variants },
    }));
    return toMediaFile(data.file);
  }

  static async saveVariants(fileId: string, variants: EncodedMediaVariants): Promise<LibraryMediaFile> {
    const form = new FormData();
    form.set("width", String(variants.width));
    form.set("height", String(variants.height));
    for (const [width, blob] of variants.files) form.set(`w${width}`, blob, `${width}.webp`);
    const response = await fetch(`${MEDIA_API}/${encodeURIComponent(fileId)}/variants`, {
      method: "POST",
      credentials: "same-origin",
      body: form,
    });
    const data = await parseDirectResponse<{ file: MediaFileDto }>(response);
    return toMediaFile(data.file);
  }

  static async fetchOriginal(fileId: string): Promise<Blob> {
    const response = await fetch(`${MEDIA_API}/${encodeURIComponent(fileId)}/original`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) throw new AdminApiResponseError(mediaText("serverError"), response.status);
    return response.blob();
  }

  /** First page of images that still lack renditions (oldest first). */
  static async fetchFilesMissingVariants(cursor: string | undefined, limit: number): Promise<MediaApiResponse> {
    const data = await apiData(getApiV1AdminMedia({
      query: { cursor, limit, variants: "missing", sortOrder: "asc" },
    }));
    return { files: data.files.map(toMediaFile), pagination: data.pagination };
  }

  static async abortUpload(sessionId: string): Promise<void> {
    await apiData(deleteApiV1AdminMediaUploadsById({ path: { id: sessionId } }));
  }
}

export type { CursorPagination };
