import type { MediaKind } from "@scalius/shared/media-policy";

export type MediaCapability = "image" | "video" | "both";
export type MediaLibraryView = "ready" | "trash";

export interface MediaFile {
  id: string;
  url: string;
  filename: string;
  size: number;
  createdAt: Date;
  mimeType?: string;
  altText?: string | null;
  width?: number | null;
  height?: number | null;
  folderId?: string | null;
  updatedAt?: Date;
}

export interface LibraryMediaFile extends MediaFile {
  objectKey: string;
  kind: MediaKind;
  mimeType: string;
  altText: string | null;
  caption: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  posterMediaId: string | null;
  posterUrl: string | null;
  folderId: string | null;
  status: "ready" | "trashed" | "deleting" | "deleted";
  version: number;
  updatedAt: Date;
  trashedAt: Date | null;
  deletedAt: Date | null;
}

export interface MediaFolder {
  id: string;
  name: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface CursorPagination {
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface MediaApiResponse {
  files: LibraryMediaFile[];
  pagination: CursorPagination;
}

export interface MediaFilterOptions {
  search: string;
  folderId?: string | null;
  sortBy: "createdAt" | "filename" | "size";
  sortOrder: "asc" | "desc";
  kind?: MediaKind;
  view: MediaLibraryView;
}

export type UploadItemStatus =
  | "queued"
  | "initiating"
  | "uploading"
  | "paused"
  | "completing"
  | "complete"
  | "failed"
  | "cancelled";

export interface UploadQueueItem {
  id: string;
  file: File;
  kind: MediaKind;
  status: UploadItemStatus;
  progress: number;
  uploadedParts: number[];
  expectedParts: number;
  sessionId: string | null;
  failedPart: number | null;
  error: string | null;
  warning: string | null;
  result: LibraryMediaFile | null;
}

export interface MediaManagerProps {
  onSelect?: (file: MediaFile) => void;
  onSelectMultiple?: (files: MediaFile[]) => void;
  selectedFiles?: MediaFile[];
  triggerLabel?: string;
  capability?: MediaCapability;
  dialogClassName?: string;
  trigger?: React.ReactNode;
}

export const ITEMS_PER_PAGE = 24;

export function capabilityAccept(capability: MediaCapability): string {
  if (capability === "image") return "image/jpeg,image/png,image/gif,image/webp,image/avif";
  if (capability === "video") return "video/mp4,video/webm";
  return "image/jpeg,image/png,image/gif,image/webp,image/avif,video/mp4,video/webm";
}

export function capabilityKind(capability: MediaCapability): MediaKind | undefined {
  return capability === "both" ? undefined : capability;
}
