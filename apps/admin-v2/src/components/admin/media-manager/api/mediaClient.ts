// Media API Client

import type {
  MediaFile,
  MediaFolder,
  MediaApiResponse,
  MediaFilterOptions,
} from "../types";
import { unixToDate } from "@scalius/shared/timestamps";
import { extractApiError, extractApiErrorDetails, unwrapEnvelope } from "~/lib/api-helpers";
import {
  getMediaList as getMediaFiles,
  deleteMedia,
  updateMedia,
  getMediaFolders,
  createMediaFolder as createMediaFolderFn,
  deleteMediaFolder as deleteMediaFolderFn,
  moveMediaFiles as moveMediaFilesFn,
  type MediaFileDto,
  type MediaFolderDto,
} from "~/lib/api-functions/media";

/** Shape of the upload response JSON — varies between success, partial, and error */
interface UploadResponseData {
  files?: MediaFileDto[];
  warnings?: Array<{ filename: string; error: string }>;
  summary?: string;
  error?: string;
  details?: Array<{ filename: string; error: string }> | string;
}

function toDate(value: string | number | Date | null | undefined): Date {
  return unixToDate(value) ?? new Date(0);
}

function toOptionalDate(
  value: string | number | Date | null | undefined,
): Date | undefined {
  return unixToDate(value) ?? undefined;
}

function toMediaFile(file: MediaFileDto): MediaFile {
  return {
    id: file.id,
    url: file.url,
    filename: file.filename,
    size: file.size,
    mimeType: file.mimeType,
    altText: file.altText ?? null,
    width: file.width ?? null,
    height: file.height ?? null,
    folderId: file.folderId ?? null,
    createdAt: toDate(file.createdAt),
    updatedAt: toOptionalDate(file.updatedAt),
  };
}

function toMediaFolder(folder: MediaFolderDto): MediaFolder {
  return {
    id: folder.id,
    name: folder.name,
    parentId: folder.parentId ?? null,
    createdAt: toDate(folder.createdAt),
    updatedAt: toOptionalDate(folder.updatedAt),
  };
}

export class MediaApiClient {
  /**
   * Fetch media files with pagination and filtering
   */
  static async fetchFiles(
    page: number = 1,
    limit: number = 20,
    filters: Partial<MediaFilterOptions> = {},
  ): Promise<MediaApiResponse> {
    const data = await getMediaFiles({
      data: {
        page,
        limit,
        search: filters.search,
        folderId:
          filters.folderId === undefined ? undefined : filters.folderId,
        sortBy: filters.sortBy,
        sortOrder: filters.sortOrder,
        mimeType: filters.mimeType ?? undefined,
      },
    });
    return {
      files: data.files.map(toMediaFile),
      pagination: data.pagination,
    };
  }

  /**
   * Upload files to the media library with improved error handling
   */
  static async uploadFiles(
    files: FileList | File[],
    folderId?: string | null,
  ): Promise<
    | MediaFile[]
    | {
      files: MediaFile[];
      warnings?: Array<{ filename: string; error: string }>;
      summary?: string;
    }
  > {
    try {
      const formData = new FormData();

      Array.from(files).forEach((file) => {
        formData.append("files", file);
      });

      if (folderId) {
        formData.append("folderId", folderId);
      }

      const response = await fetch("/api/v1/admin/media/upload", {
        method: "POST",
        body: formData,
      });

      // Parse response JSON
      let rawData: Record<string, unknown>;
      try {
        rawData = await response.json();
      } catch (parseError) {
        if (import.meta.env.DEV) console.error("Failed to parse upload response:", parseError);
        throw new Error(
          "Upload failed: Server returned an invalid response. Please try again."
        );
      }

      // Handle errors (4xx, 5xx)
      if (!response.ok) {
        const errorMessage = extractApiError(rawData, "Upload failed for unknown reason");
        const error: Error & { details?: Array<{ filename: string; error: string }>; summary?: string } = new Error(errorMessage);

        // Attach details array if available
        const details = extractApiErrorDetails(rawData);
        if (details) {
          error.details = details as Array<{ filename: string; error: string }>;
        }

        throw error;
      }

      // Unwrap envelope for success responses
      const data = unwrapEnvelope<UploadResponseData>(rawData);

      const uploadedFiles = (data.files || []).map(toMediaFile);

      if (data.warnings || data.summary) {
        return {
          files: uploadedFiles,
          warnings: data.warnings,
          summary: data.summary,
        };
      }

      return uploadedFiles;
    } catch (error: unknown) {
      // Re-throw with better context if it's a network error
      if (error instanceof TypeError && error.message.includes("fetch")) {
        throw new Error(
          "Network error: Unable to reach the server. Please check your connection."
        );
      }

      // Re-throw the error as-is if it already has a message
      throw error;
    }
  }

  /**
   * Delete a single media file
   */
  static async deleteFile(fileId: string): Promise<void> {
    await deleteMedia({ data: { fileId } });
  }

  /**
   * Delete multiple files
   */
  static async deleteFiles(fileIds: string[]): Promise<{
    success: number;
    failed: number;
  }> {
    let success = 0;
    let failed = 0;

    for (const fileId of fileIds) {
      try {
        await this.deleteFile(fileId);
        success++;
      } catch (error: unknown) {
        failed++;
        if (import.meta.env.DEV) console.error(`Failed to delete file ${fileId}:`, error);
      }
    }

    return { success, failed };
  }

  /**
   * Fetch all folders
   */
  static async fetchFolders(): Promise<MediaFolder[]> {
    const data = await getMediaFolders();
    return (data.folders ?? []).map(toMediaFolder);
  }

  /**
   * Create a new folder
   */
  static async createFolder(
    name: string,
    parentId?: string | null,
  ): Promise<MediaFolder> {
    const data = await createMediaFolderFn({
      data: { name, parentId: parentId || undefined },
    });
    return toMediaFolder(data.folder);
  }

  /**
   * Delete a folder
   */
  static async deleteFolder(folderId: string): Promise<void> {
    await deleteMediaFolderFn({ data: { folderId } });
  }

  /**
   * Move files to a folder
   */
  static async moveFilesToFolder(
    fileIds: string[],
    folderId: string | null,
  ): Promise<void> {
    await moveMediaFilesFn({ data: { fileIds, folderId } });
  }

  /**
   * Update file metadata
   */
  static async updateFileMetadata(
    fileId: string,
    updates: { filename?: string; folderId?: string | null },
  ): Promise<MediaFile> {
    const data = await updateMedia({
      data: { fileId, update: updates },
    });
    return toMediaFile(data.file);
  }

  /**
   * Update file alt text
   */
  static async updateAltText(
    fileId: string,
    altText: string,
  ): Promise<MediaFile> {
    const data = await updateMedia({
      data: { fileId, update: { altText } },
    });
    return toMediaFile(data.file);
  }
}
