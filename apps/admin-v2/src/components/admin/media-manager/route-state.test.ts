import { describe, expect, it } from "vitest";
import {
  mediaRouteSearchToWorkspaceState,
  mediaWorkspaceStateToRouteSearch,
  validateMediaSearch,
} from "./route-state";

describe("Media route state", () => {
  it("normalizes an empty or invalid address to the canonical library workspace", () => {
    expect(validateMediaSearch({
      view: "missing",
      folder: "../../unsafe",
      kind: "document",
      sort: "random",
    })).toEqual({
      view: undefined,
      folder: undefined,
      kind: undefined,
      sort: undefined,
    });
  });

  it("never reads a search term from the address", () => {
    expect(validateMediaSearch({ search: "01712345678" })).not.toHaveProperty("search");
  });

  it("restores the exact safe folder, kind, sort and view, with the term from the session", () => {
    const routeSearch = validateMediaSearch({
      view: "trash",
      folder: "folder_Abc-123_xyz",
      kind: "video",
      sort: "name-desc",
    });

    expect(mediaRouteSearchToWorkspaceState(routeSearch, "walkthrough")).toEqual({
      view: "trash",
      folderId: "folder_Abc-123_xyz",
      search: "walkthrough",
      kind: "video",
      sortBy: "filename",
      sortOrder: "desc",
    });
  });

  it("writes only the filters to the address, never the search term", () => {
    expect(mediaWorkspaceStateToRouteSearch({
      view: "ready",
      folderId: "all",
      search: "",
      kind: undefined,
      sortBy: "createdAt",
      sortOrder: "desc",
    })).toEqual({
      view: undefined,
      folder: undefined,
      kind: undefined,
      sort: undefined,
    });

    expect(mediaWorkspaceStateToRouteSearch({
      view: "trash",
      folderId: null,
      search: "campaign",
      kind: "image",
      sortBy: "size",
      sortOrder: "asc",
    })).toEqual({
      view: "trash",
      folder: "unfiled",
      kind: "image",
      sort: "smallest",
    });
  });
});
