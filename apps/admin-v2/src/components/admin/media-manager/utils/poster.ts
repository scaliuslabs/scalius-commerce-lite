import type { LibraryMediaFile } from "../types";

export function resolveSavedPoster(file: LibraryMediaFile | null, visibleFiles: LibraryMediaFile[]) {
  const loaded = file?.posterMediaId
    ? visibleFiles.find((candidate) => candidate.id === file.posterMediaId && candidate.kind === "image") ?? null
    : null;
  return {
    poster: loaded,
    posterMediaId: file?.posterMediaId ?? null,
    posterUrl: loaded?.url ?? file?.posterUrl ?? null,
  };
}
