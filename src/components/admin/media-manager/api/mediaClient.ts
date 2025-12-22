// Media API Client

import type {
  MediaFile,
  MediaFolder,
  MediaApiResponse,
  MediaFoldersApiResponse,
  MediaFilterOptions,
} from "../types";

export class MediaApiClient {
  /**
   * Fetch media files with pagination and filtering
   */
  static async fetchFiles(
    page: number = 1,
    limit: number = 20,
    filters: Partial<MediaFilterOptions> = {},
  ): Promise<MediaApiResponse> {
    const params = new URLSearchParams({
      page: page.toString(),
      limit: limit.toString(),
    });

    if (filters.search) {
      params.append("search", filters.search);
    }

    if (filters.folderId !== undefined) {
      params.append("folderId", filters.folderId || "");
    }

    if (filters.sortBy) {
      params.append("sortBy", filters.sortBy);
    }

    if (filters.sortOrder) {
      params.append("sortOrder", filters.sortOrder);
    }

    const response = await fetch(`/api/media?${params.toString()}`);

    if (!response.ok) {
      throw new Error("Failed to load files");
    }

    return response.json();
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

      const response = await fetch("/api/media/upload", {
        method: "POST",
        body: formData,
      });

      // Parse response JSON
      let data: any;
      try {
        data = await response.json();
      } catch (parseError) {
        console.error("Failed to parse upload response:", parseError);
        throw new Error(
          "Upload failed: Server returned an invalid response. Please try again."
        );
      }

      // Handle success (201) and partial success (207)
      if (response.status === 207 || response.status === 201) {
        // Return the full response object if there are warnings or summary
        if (data.warnings || data.summary) {
          return {
            files: data.files || [],
            warnings: data.warnings,
            summary: data.summary,
          };
        }
        return data.files || []; // Just the files array for backward compatibility
      }

      // Handle errors (4xx, 5xx)
      if (!response.ok) {
        // Create a more informative error object
        const errorMessage =
          data.error || data.details || "Upload failed for unknown reason";
        const error: any = new Error(errorMessage);

        // Attach details array if available
        if (data.details && Array.isArray(data.details)) {
          error.details = data.details;
        }

        // Attach summary if available
        if (data.summary) {
          error.summary = data.summary;
        }

        throw error;
      }

      // Fallback for unexpected responses
      return data.files || [];
    } catch (error: any) {
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
    const response = await fetch(`/api/media/${fileId}`, {
      method: "DELETE",
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || "Failed to delete file");
    }
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
      } catch (error) {
        failed++;
        console.error(`Failed to delete file ${fileId}:`, error);
      }
    }

    return { success, failed };
  }

  /**
   * Fetch all folders
   */
  static async fetchFolders(): Promise<MediaFolder[]> {
    const response = await fetch("/api/media/folders");

    if (!response.ok) {
      throw new Error("Failed to load folders");
    }

    const data: MediaFoldersApiResponse = await response.json();
    return data.folders;
  }

  /**
   * Create a new folder
   */
  static async createFolder(
    name: string,
    parentId?: string | null,
  ): Promise<MediaFolder> {
    const response = await fetch("/api/media/folders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, parentId }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || "Failed to create folder");
    }

    const data = await response.json();
    return data.folder;
  }

  /**
   * Delete a folder
   */
  static async deleteFolder(folderId: string): Promise<void> {
    const response = await fetch(`/api/media/folders/${folderId}`, {
      method: "DELETE",
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || "Failed to delete folder");
    }
  }

  /**
   * Move files to a folder
   */
  static async moveFilesToFolder(
    fileIds: string[],
    folderId: string | null,
  ): Promise<void> {
    const response = await fetch("/api/media/move", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fileIds, folderId }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || "Failed to move files");
    }
  }

  /**
   * Update file metadata
   */
  static async updateFileMetadata(
    fileId: string,
    updates: { filename?: string; folderId?: string | null },
  ): Promise<MediaFile> {
    const response = await fetch(`/api/media/${fileId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(updates),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || "Failed to update file");
    }

    const data = await response.json();
    return data.file;
  }
}
