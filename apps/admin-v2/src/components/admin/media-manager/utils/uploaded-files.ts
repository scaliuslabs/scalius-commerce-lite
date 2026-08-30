import { ITEMS_PER_PAGE, type LibraryMediaFile, type MediaFilterOptions } from "../types";

function matchesFilters(file: LibraryMediaFile, filters: MediaFilterOptions): boolean {
  if (filters.view !== "ready" || file.status !== "ready") return false;
  if (filters.kind && file.kind !== filters.kind) return false;
  if (filters.folderId !== undefined && file.folderId !== filters.folderId) return false;

  const search = filters.search.trim().toLocaleLowerCase();
  return !search || file.filename.toLocaleLowerCase().includes(search);
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareFiles(
  left: LibraryMediaFile,
  right: LibraryMediaFile,
  filters: MediaFilterOptions,
): number {
  const direction = filters.sortOrder === "asc" ? 1 : -1;
  const primary = filters.sortBy === "filename"
    ? compareStrings(left.filename, right.filename)
    : filters.sortBy === "size"
      ? left.size - right.size
      : left.createdAt.getTime() - right.createdAt.getTime();

  return (primary || compareStrings(left.id, right.id)) * direction;
}

/**
 * Insert server-committed uploads into the visible page immediately. The
 * caller still refreshes in the background so cursor pagination remains
 * authoritative after this optimistic presentation update.
 */
export function mergeUploadedFiles(
  current: LibraryMediaFile[],
  uploaded: LibraryMediaFile[],
  filters: MediaFilterOptions,
): LibraryMediaFile[] {
  const merged = new Map(current.map((file) => [file.id, file]));

  for (const file of uploaded) {
    if (matchesFilters(file, filters)) merged.set(file.id, file);
    else merged.delete(file.id);
  }

  const visibleLimit = Math.max(ITEMS_PER_PAGE, current.length);
  return [...merged.values()]
    .sort((left, right) => compareFiles(left, right, filters))
    .slice(0, visibleLimit);
}
