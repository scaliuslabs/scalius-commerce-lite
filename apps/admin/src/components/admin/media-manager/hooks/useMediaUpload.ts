// Hook for managing media uploads

import { useState, useCallback } from "react";
import { MediaApiClient } from "../api";
import type { MediaFile, UploadProgress } from "../types";
import { toast } from "sonner";
import { validateFiles } from "../utils";

interface UseMediaUploadOptions {
  maxSizeMB?: number;
  acceptedTypes?: string;
  maxFiles?: number;
  folderId?: string | null;
  onUploadComplete?: (files: MediaFile[]) => void;
}

export function useMediaUpload(options: UseMediaUploadOptions = {}) {
  const {
    maxSizeMB = 10,
    acceptedTypes = "image/*",
    maxFiles = 20,
    folderId,
    onUploadComplete,
  } = options;

  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress[]>([]);
  const [currentUploadStatus, setCurrentUploadStatus] = useState<string>("");

  const uploadFiles = useCallback(
    async (files: FileList | File[] | null) => {
      if (!files || files.length === 0) return;

      // Validate files
      const validation = validateFiles(files, {
        maxSizeMB,
        acceptedTypes,
        maxFiles,
      });

      if (!validation.isValid) {
        toast.error("Validation Error", { description: validation.error });
        return;
      }

      setIsUploading(true);

      // Initialize progress for each file
      const fileArray = Array.from(files);
      setUploadProgress(
        fileArray.map((file, index) => ({
          fileIndex: index,
          fileName: file.name,
          progress: 0,
          total: fileArray.length,
        })),
      );

      try {
        const result = await MediaApiClient.uploadFiles(files, folderId);

        // Handle both the response data and potential warnings
        const uploadedFiles = Array.isArray(result) ? result : result.files;
        const warnings = Array.isArray(result) ? undefined : result.warnings;
        const summary = Array.isArray(result) ? undefined : result.summary;

        if (warnings && warnings.length > 0) {
          // Partial success - some files failed
          const successCount = uploadedFiles.length;
          const failCount = warnings.length;

          // Show summary toast
          toast.success("Partial Upload Success", { description: summary || `${successCount} file(s) uploaded, ${failCount} failed` });

          // Log detailed errors for debugging
          warnings.forEach((warning: { filename: string; error: string }) => {
            console.error(`Failed to upload "${warning.filename}":`, warning.error);
          });

          // Show detailed failure toast after a brief delay
          setTimeout(() => {
            const failedFilesList = warnings
              .map((w: { filename: string; error: string }) => {
                // Truncate long error messages
                const errorMsg = w.error.length > 60 ? w.error.substring(0, 60) + "..." : w.error;
                return `• ${w.filename}: ${errorMsg}`;
              })
              .slice(0, 3)
              .join("\n");
            const moreFiles = warnings.length > 3 ? `\n...and ${warnings.length - 3} more file(s)` : "";

            toast.error(`${failCount} File(s) Failed`, { description: `${failedFilesList}${moreFiles}` });
          }, 600);
        } else {
          // Complete success
          toast.success("Upload Successful", { description: summary || `Successfully uploaded ${uploadedFiles.length} file${uploadedFiles.length !== 1 ? "s" : ""}.` });
        }

        onUploadComplete?.(uploadedFiles);

        return uploadedFiles;
      } catch (error: unknown) {
        console.error("Error uploading files:", error);

        const message = error instanceof Error ? error.message : "Could not upload files. Please try again.";
        toast.error("Upload Failed", { description: message });
        throw error;
      } finally {
        setIsUploading(false);
        setUploadProgress([]);
        setCurrentUploadStatus("");
      }
    },
    [maxSizeMB, acceptedTypes, maxFiles, folderId, onUploadComplete],
  );

  const uploadFilesWrapper = useCallback(
    async (files: FileList | null) => {
      await uploadFiles(files);
    },
    [uploadFiles],
  );

  return {
    isUploading,
    uploadProgress,
    currentUploadStatus,
    uploadFiles: uploadFilesWrapper,
  };
}
