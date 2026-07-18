import type {
  MediaFilterOptions,
  MediaWorkspaceRouteState,
} from "./types";

export const MEDIA_SORTS = {
  newest: ["createdAt", "desc"],
  oldest: ["createdAt", "asc"],
  largest: ["size", "desc"],
  smallest: ["size", "asc"],
  "name-asc": ["filename", "asc"],
  "name-desc": ["filename", "desc"],
} as const satisfies Record<
  string,
  readonly [MediaFilterOptions["sortBy"], MediaFilterOptions["sortOrder"]]
>;

export type MediaSortKey = keyof typeof MEDIA_SORTS;

export interface MediaRouteSearch {
  view?: "trash";
  folder?: string;
  kind?: MediaWorkspaceRouteState["kind"];
  sort?: MediaSortKey;
  search?: string;
}

const MEDIA_SORT_KEYS = new Set<MediaSortKey>(
  Object.keys(MEDIA_SORTS) as MediaSortKey[],
);
const FOLDER_ID = /^folder_[A-Za-z0-9_-]{1,120}$/;

function normalizeFolder(value: unknown): string | undefined {
  if (value === "unfiled") return value;
  return typeof value === "string" && FOLDER_ID.test(value) ? value : undefined;
}

function normalizeSearch(value: unknown): string {
  if (typeof value !== "string") return "";
  return Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join("")
    .slice(0, 200);
}

export function validateMediaSearch(search: Record<string, unknown>): MediaRouteSearch {
  const sort = typeof search.sort === "string" && MEDIA_SORT_KEYS.has(search.sort as MediaSortKey)
    ? search.sort as MediaSortKey
    : undefined;
  const normalizedSearch = normalizeSearch(search.search);

  return {
    view: search.view === "trash" ? "trash" : undefined,
    folder: normalizeFolder(search.folder),
    kind: search.kind === "image" || search.kind === "video" ? search.kind : undefined,
    sort: sort === "newest" ? undefined : sort,
    search: normalizedSearch || undefined,
  };
}

export function mediaRouteSearchToWorkspaceState(
  search: MediaRouteSearch,
): MediaWorkspaceRouteState {
  const [sortBy, sortOrder] = MEDIA_SORTS[search.sort ?? "newest"];
  return {
    view: search.view ?? "ready",
    folderId: search.folder === "unfiled"
        ? null
        : search.folder ?? "all",
    search: search.search ?? "",
    kind: search.kind,
    sortBy,
    sortOrder,
  };
}

export function mediaWorkspaceStateToRouteSearch(
  state: MediaWorkspaceRouteState,
): Record<string, string | undefined> {
  const sort = (Object.entries(MEDIA_SORTS) as Array<
    [MediaSortKey, readonly [MediaFilterOptions["sortBy"], MediaFilterOptions["sortOrder"]]]
  >).find(([, value]) => value[0] === state.sortBy && value[1] === state.sortOrder)?.[0] ?? "newest";

  return {
    view: state.view === "trash" ? "trash" : undefined,
    folder: state.folderId === "all" ? undefined : state.folderId === null ? "unfiled" : state.folderId,
    kind: state.kind,
    sort: sort === "newest" ? undefined : sort,
    search: state.search || undefined,
  };
}
