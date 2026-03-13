// Formatting utilities for media manager

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

export function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatDateTime(date: Date | string): string {
  return new Date(date).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatFileType(mimeType: string): string {
  const typeMap: Record<string, string> = {
    "image/jpeg": "JPEG Image",
    "image/jpg": "JPG Image",
    "image/png": "PNG Image",
    "image/gif": "GIF Image",
    "image/webp": "WebP Image",
    "image/svg+xml": "SVG Image",
  };
  return typeMap[mimeType] || mimeType;
}

export function truncateFilename(
  filename: string,
  maxLength: number = 30,
): string {
  if (filename.length <= maxLength) return filename;

  const extension = filename.split(".").pop() || "";
  const nameWithoutExt = filename.substring(
    0,
    filename.length - extension.length - 1,
  );
  const truncatedName = nameWithoutExt.substring(
    0,
    maxLength - extension.length - 4,
  );

  return `${truncatedName}...${extension}`;
}

export function bytesToMB(bytes: number): number {
  return bytes / (1024 * 1024);
}

export function mbToBytes(mb: number): number {
  return mb * 1024 * 1024;
}
