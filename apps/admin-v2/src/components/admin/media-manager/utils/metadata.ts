import { AdminApiResponseError } from "~/lib/admin-api-error";
import type { LibraryMediaFile } from "../types";

export function isMediaVersionConflict(error: unknown): boolean {
  return error instanceof AdminApiResponseError && error.status === 409 && error.code === "conflict";
}

export function mediaMetadata(file: LibraryMediaFile) {
  return {
    filename: file.filename.trim(),
    description: (file.kind === "video" ? file.caption : file.altText)?.trim() || null,
    posterMediaId: file.kind === "video" ? file.posterMediaId : null,
  };
}
