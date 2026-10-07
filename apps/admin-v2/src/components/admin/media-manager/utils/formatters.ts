// Formatting utilities for media manager

import { unixToDate } from "@scalius/shared/timestamps";
import { formatDateTime, formatNumber } from "~/i18n";

/** A media timestamp in store time, in the dashboard language. */
export function formatDate(value: Date | number | string | null | undefined): string {
  const date = unixToDate(value ?? null);
  return date && Number.isFinite(date.getTime()) ? formatDateTime(date, { dateStyle: "medium", timeStyle: "short" }) : "—";
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

/** "12.5 MB" in the dashboard's number format. */
export function formatFileSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${formatNumber(value, { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`;
}
