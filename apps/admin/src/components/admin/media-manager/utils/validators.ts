// Validation utilities for media manager

import { bytesToMB } from "./formatters";

export interface ValidationResult {
  isValid: boolean;
  error?: string;
}

export function validateFileSize(
  file: File,
  maxSizeMB: number,
): ValidationResult {
  const fileSizeMB = bytesToMB(file.size);

  if (fileSizeMB > maxSizeMB) {
    return {
      isValid: false,
      error: `File size (${fileSizeMB.toFixed(2)}MB) exceeds maximum allowed size (${maxSizeMB}MB)`,
    };
  }

  return { isValid: true };
}

export function validateFileType(
  file: File,
  acceptedTypes: string,
): ValidationResult {
  // Convert accepted types string to array
  // e.g., "image/*" or "image/png,image/jpeg"
  const types = acceptedTypes.split(",").map((t) => t.trim());

  // Check for wildcard types (e.g., "image/*")
  const wildcardMatch = types.some((type) => {
    if (type.includes("*")) {
      const baseType = type.split("/")[0];
      return file.type.startsWith(baseType + "/");
    }
    return false;
  });

  // Check for exact matches
  const exactMatch = types.includes(file.type);

  if (!wildcardMatch && !exactMatch) {
    return {
      isValid: false,
      error: `File type "${file.type}" is not supported. Accepted types: ${acceptedTypes}`,
    };
  }

  return { isValid: true };
}

export function validateFiles(
  files: FileList | File[],
  options: {
    maxSizeMB?: number;
    acceptedTypes?: string;
    maxFiles?: number;
  } = {},
): ValidationResult {
  const { maxSizeMB = 10, acceptedTypes = "image/*", maxFiles = 20 } = options;

  const fileArray = Array.from(files);

  // Check number of files
  if (fileArray.length > maxFiles) {
    return {
      isValid: false,
      error: `Too many files selected. Maximum allowed: ${maxFiles}`,
    };
  }

  // Validate each file
  for (const file of fileArray) {
    const sizeValidation = validateFileSize(file, maxSizeMB);
    if (!sizeValidation.isValid) {
      return {
        isValid: false,
        error: `File "${file.name}": ${sizeValidation.error}`,
      };
    }

    const typeValidation = validateFileType(file, acceptedTypes);
    if (!typeValidation.isValid) {
      return {
        isValid: false,
        error: `File "${file.name}": ${typeValidation.error}`,
      };
    }
  }

  return { isValid: true };
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

export function filterImageFiles(files: FileList | File[]): File[] {
  return Array.from(files).filter(isImageFile);
}
