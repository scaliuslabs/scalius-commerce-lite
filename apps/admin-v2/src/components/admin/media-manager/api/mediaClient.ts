// Media API Client

import type {
  MediaFile,
  MediaFolder,
  MediaApiResponse,
  MediaFilterOptions,
  GeneratedImagePreview,
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
    sourceType: file.sourceType ?? null,
    generationId: file.generationId ?? null,
    generationProvider: file.generationProvider ?? null,
    generationModel: file.generationModel ?? null,
    generationPromptHash: file.generationPromptHash ?? null,
    generationInputTokens: file.generationInputTokens ?? null,
    generationOutputTokens: file.generationOutputTokens ?? null,
    generationTotalTokens: file.generationTotalTokens ?? null,
    generationCostUsdMicros: file.generationCostUsdMicros ?? null,
    generationCostStatus: file.generationCostStatus ?? null,
    generatedAt: unixToDate(file.generatedAt) ?? null,
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
  static async generateImagePreview(input: {
    prompt: string;
    aspectRatio: "auto" | "1:1" | "2:3" | "4:5" | "3:2" | "16:9";
    seed?: number;
    signal?: AbortSignal;
  }): Promise<GeneratedImagePreview> {
    const timeout = AbortSignal.timeout(35_000);
    const signal = input.signal
      ? AbortSignal.any([input.signal, timeout])
      : timeout;
    const response = await fetch(
      "/api/v1/admin/media/image-generation/generate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: input.prompt,
          aspectRatio: input.aspectRatio,
          ...(input.seed !== undefined ? { seed: input.seed } : {}),
        }),
        signal,
      },
    );

    if (!response.ok) {
      throw new Error(await responseErrorMessage(response, "Image generation failed."));
    }

    const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim();
    if (
      mediaType !== "image/jpeg" &&
      mediaType !== "image/png" &&
      mediaType !== "image/webp"
    ) {
      throw new Error("Image generation returned an unsupported file type.");
    }

    const generationId = response.headers.get("x-scalius-generation-id") ?? "";
    const provider = response.headers.get("x-scalius-generation-provider") ?? "";
    const encodedModel = response.headers.get("x-scalius-generation-model") ?? "";
    const promptHash = response.headers.get("x-scalius-generation-prompt-hash") ?? "";
    const costStatus = response.headers.get("x-scalius-generation-cost-status");
    const expiresAt = new Date(
      response.headers.get("x-scalius-generation-expires-at") ?? "",
    );

    if (
      !/^aig_[A-Za-z0-9_-]{10,100}$/.test(generationId) ||
      !provider ||
      !encodedModel ||
      !/^[a-f0-9]{64}$/.test(promptHash) ||
      (costStatus !== "reported" && costStatus !== "not_reported") ||
      Number.isNaN(expiresAt.getTime())
    ) {
      throw new Error("Image generation returned incomplete provenance.");
    }

    let model: string;
    try {
      model = decodeURIComponent(encodedModel);
    } catch {
      throw new Error("Image generation returned invalid model provenance.");
    }

    const blob = await response.blob();
    if (blob.size <= 0 || blob.size > 10 * 1024 * 1024 || blob.type !== mediaType) {
      throw new Error("Image generation returned invalid image bytes.");
    }

    return {
      generationId,
      blob,
      mediaType,
      provider,
      model,
      promptHash,
      usage: {
        inputTokens: readOptionalTokenHeader(
          response.headers,
          "x-scalius-generation-input-tokens",
        ),
        outputTokens: readOptionalTokenHeader(
          response.headers,
          "x-scalius-generation-output-tokens",
        ),
        totalTokens: readOptionalTokenHeader(
          response.headers,
          "x-scalius-generation-total-tokens",
        ),
      },
      cost: { status: costStatus },
      expiresAt,
    };
  }

  static async saveGeneratedImage(input: {
    preview: GeneratedImagePreview;
    altText?: string;
    folderId?: string | null;
  }): Promise<MediaFile> {
    const formData = new FormData();
    const extension =
      input.preview.mediaType === "image/jpeg"
        ? "jpg"
        : input.preview.mediaType === "image/webp"
          ? "webp"
          : "png";
    formData.append(
      "file",
      new File(
        [input.preview.blob],
        `generated-${input.preview.generationId}.${extension}`,
        { type: input.preview.mediaType },
      ),
    );
    formData.append("generationId", input.preview.generationId);
    if (input.altText?.trim()) formData.append("altText", input.altText.trim());
    if (input.folderId) formData.append("folderId", input.folderId);

    const response = await fetch("/api/v1/admin/media/image-generation/save", {
      method: "POST",
      body: formData,
    });
    let rawData: Record<string, unknown>;
    try {
      rawData = await response.json();
    } catch {
      throw new Error("Saving the generated image returned an invalid response.");
    }
    if (!response.ok) {
      throw new Error(
        extractApiError(rawData, "Saving the generated image failed."),
      );
    }
    const payload = unwrapEnvelope<{ file?: MediaFileDto }>(rawData);
    if (!payload.file) {
      throw new Error("Saving the generated image returned no media file.");
    }
    return toMediaFile(payload.file);
  }

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

function readOptionalTokenHeader(
  headers: Headers,
  name: string,
): number | undefined {
  const raw = headers.get(name);
  if (raw === null) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 1_000_000_000
    ? parsed
    : undefined;
}

async function responseErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    const raw = (await response.json()) as Record<string, unknown>;
    return extractApiError(raw, fallback);
  } catch {
    return fallback;
  }
}
