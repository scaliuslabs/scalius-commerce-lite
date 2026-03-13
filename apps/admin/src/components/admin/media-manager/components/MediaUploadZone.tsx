// Upload zone component with drag & drop support

import React, { useState } from "react";

import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Upload, Loader2, ImageIcon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import type { UploadProgress } from "../types";
import { filterImageFiles } from "../utils";
import { toast } from "@/hooks/use-toast";

interface MediaUploadZoneProps {
  onUpload: (files: FileList | null) => Promise<void>;
  isUploading: boolean;
  uploadProgress?: UploadProgress[];
  acceptedFileTypes?: string;
  maxFileSize?: number;
  className?: string;
}

export function MediaUploadZone({
  onUpload,
  isUploading,
  uploadProgress = [],
  acceptedFileTypes = "image/*",
  maxFileSize = 10,
  className = "",
}: MediaUploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false);

  const handleDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const dropZone = event.currentTarget;
    if (!dropZone.contains(event.relatedTarget as Node)) {
      setIsDragging(false);
    }
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    if (!isDragging) {
      setIsDragging(true);
    }
  };

  const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);

    const droppedFiles = event.dataTransfer.files;
    if (droppedFiles && droppedFiles.length > 0) {
      const imageFiles = filterImageFiles(droppedFiles);
      if (imageFiles.length > 0) {
        const dataTransfer = new DataTransfer();
        imageFiles.forEach((file) => dataTransfer.items.add(file));
        await onUpload(dataTransfer.files);
      } else {
        toast({
          title: "Invalid File Type",
          description: "Only image files can be uploaded via drag and drop.",
          variant: "destructive",
        });
      }
      event.dataTransfer.clearData();
    }
  };

  const handleFileInputChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    await onUpload(event.target.files);
    // Clear the input so the same file can be uploaded again if needed
    event.target.value = "";
  };

  return (
    <div
      className={`relative ${className}`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-background/80 backdrop-blur-sm rounded-md">
          <div className="bg-background/95 p-10 rounded-lg shadow-lg border border-primary/20 flex flex-col items-center">
            <ImageIcon className="h-16 w-16 text-primary mb-4 animate-bounce" />
            <p className="text-xl font-semibold text-primary mb-2">
              Drop images to upload
            </p>
            <p className="text-sm text-muted-foreground">
              Release to add files to your media library
            </p>
          </div>
        </div>
      )}

      {/* Upload button */}
      <div className="relative">
        <label
          htmlFor="media-file-upload-input"
          className={buttonVariants({ variant: "default" }) + " cursor-pointer"}
        >
          {isUploading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Uploading...
            </>
          ) : (
            <>
              <Upload className="mr-2 h-4 w-4" />
              Upload Files
            </>
          )}
        </label>
        <Input
          type="file"
          id="media-file-upload-input"
          accept={acceptedFileTypes}
          multiple
          onChange={handleFileInputChange}
          disabled={isUploading}
          className="sr-only"
        />
      </div>

      {/* Upload progress */}
      {isUploading && uploadProgress.length > 0 && (
        <div className="mt-4 space-y-2">
          {uploadProgress.map((progress) => (
            <div key={progress.fileIndex} className="space-y-1">
              <div className="flex items-center justify-between text-sm">
                <span className="truncate flex-1">{progress.fileName}</span>
                <span className="text-muted-foreground ml-2">
                  {progress.progress}%
                </span>
              </div>
              <Progress value={progress.progress} className="h-1" />
            </div>
          ))}
        </div>
      )}

      {/* Helper text */}
      {!isUploading && (
        <p className="text-xs text-muted-foreground mt-2">
          Drag & drop images here or click to browse. Max size: {maxFileSize}MB
        </p>
      )}
    </div>
  );
}
