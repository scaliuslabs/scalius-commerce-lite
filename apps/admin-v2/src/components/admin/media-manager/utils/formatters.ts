// Formatting utilities for media manager

import { formatDate as formatStoreDate } from "@scalius/shared/timestamps";
import { getStoreTimeZone } from "~/lib/store-time-zone";

/** A media timestamp in store time. */
export function formatDate(value: Date | number | string | null | undefined): string {
  return formatStoreDate(value, getStoreTimeZone());
}
export { formatDate as formatDateTime };

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

export function formatFileType(mimeType: string): string {
  const typeMap: Record<string, string> = {
    "image/jpeg": "JPEG Image",
    "image/jpg": "JPG Image",
    "image/png": "PNG Image",
    "image/gif": "GIF Image",
    "image/webp": "WebP Image",
    "image/avif": "AVIF Image",
    "video/mp4": "MP4 Video",
    "video/webm": "WebM Video",
  };
  return typeMap[mimeType] || mimeType;
}

export function formatDuration(durationMs: number | null | undefined): string | null {
  if (!durationMs || !Number.isFinite(durationMs) || durationMs <= 0) return null;
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
