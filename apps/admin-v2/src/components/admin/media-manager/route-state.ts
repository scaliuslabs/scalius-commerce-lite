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

/** Folder, type, sort and tab live in the URL; the search term never does (~/lib/list-search "media"). */
export interface MediaRouteSearch {
  view?: "trash";
  folder?: string;
  kind?: MediaWorkspaceRouteState["kind"];
  sort?: MediaSortKey;
}

const MEDIA_SORT_KEYS = new Set<MediaSortKey>(
  Object.keys(MEDIA_SORTS) as MediaSortKey[],
);
const FOLDER_ID = /^folder_[A-Za-z0-9_-]{1,120}$/;

function normalizeFolder(value: unknown): string | undefined {
  if (value === "unfiled") return value;
  return typeof value === "string" && FOLDER_ID.test(value) ? value : undefined;
}

export function validateMediaSearch(search: Record<string, unknown>): MediaRouteSearch {
  const sort = typeof search.sort === "string" && MEDIA_SORT_KEYS.has(search.sort as MediaSortKey)
    ? search.sort as MediaSortKey
    : undefined;

  return {
    view: search.view === "trash" ? "trash" : undefined,
    folder: normalizeFolder(search.folder),
    kind: search.kind === "image" || search.kind === "video" ? search.kind : undefined,
    sort: sort === "newest" ? undefined : sort,
  };
}

export function mediaRouteSearchToWorkspaceState(
  search: MediaRouteSearch,
  term: string,
): MediaWorkspaceRouteState {
  const [sortBy, sortOrder] = MEDIA_SORTS[search.sort ?? "newest"];
  return {
    view: search.view ?? "ready",
    folderId: search.folder === "unfiled"
        ? null
        : search.folder ?? "all",
    search: term,
    kind: search.kind,
    sortBy,
    sortOrder,
  };
}

export function mediaWorkspaceStateToRouteSearch(
  state: MediaWorkspaceRouteState,
): MediaRouteSearch {
  const sort = (Object.entries(MEDIA_SORTS) as Array<
    [MediaSortKey, readonly [MediaFilterOptions["sortBy"], MediaFilterOptions["sortOrder"]]]
  >).find(([, value]) => value[0] === state.sortBy && value[1] === state.sortOrder)?.[0] ?? "newest";

  return {
    view: state.view === "trash" ? "trash" : undefined,
    folder: state.folderId === "all" ? undefined : state.folderId === null ? "unfiled" : state.folderId,
    kind: state.kind,
    sort: sort === "newest" ? undefined : sort,
  };
}
