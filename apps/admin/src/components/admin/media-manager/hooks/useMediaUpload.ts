// Hook for managing media uploads

import { useState, useCallback } from "react";
import { MediaApiClient } from "../api";
import type { MediaFile, UploadProgress } from "../types";
import { toast } from "@/hooks/use-toast";
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
        toast({
          title: "Validation Error",
          description: validation.error,
          variant: "destructive",
        });
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
          toast({
            title: "Partial Upload Success",
            description: summary || `${successCount} file(s) uploaded, ${failCount} failed`,
            variant: "default",
          });

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

            toast({
              title: `${failCount} File(s) Failed`,
              description: `${failedFilesList}${moreFiles}`,
              variant: "destructive",
              duration: 8000, // Show longer for error messages
            });
          }, 600);
        } else {
          // Complete success
          toast({
            title: "Upload Successful",
            description: summary || `Successfully uploaded ${uploadedFiles.length} file${uploadedFiles.length !== 1 ? "s" : ""}.`,
            duration: 4000,
          });
        }

        onUploadComplete?.(uploadedFiles);

        return uploadedFiles;
      } catch (error: any) {
        console.error("Error uploading files:", error);

        // Try to extract detailed error information
        let errorTitle = "Upload Failed";
        let errorDescription = "Could not upload files. Please try again.";

        // Use summary if available
        if (error.summary) {
          errorDescription = error.summary;
        } else if (error.message) {
          errorDescription = error.message;
        }

        // Check if error has details array (for server validation errors)
        if (error.details && Array.isArray(error.details)) {
          const detailsList = error.details
            .map((d: { filename: string; error: string }) => {
              const errorMsg = d.error.length > 50 ? d.error.substring(0, 50) + "..." : d.error;
              return `• ${d.filename}: ${errorMsg}`;
            })
            .slice(0, 3)
            .join("\n");
          const moreFiles = error.details.length > 3 ? `\n...and ${error.details.length - 3} more file(s)` : "";
          errorDescription = `${detailsList}${moreFiles}`;
        }

        toast({
          title: errorTitle,
          description: errorDescription,
          variant: "destructive",
          duration: 8000, // Show longer for errors
        });
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
