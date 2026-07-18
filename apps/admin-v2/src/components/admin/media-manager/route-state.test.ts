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
      search: 42,
    })).toEqual({
      view: undefined,
      folder: undefined,
      kind: undefined,
      sort: undefined,
      search: undefined,
    });
  });

  it("restores the exact safe folder, kind, sort, view, and bounded query", () => {
    const routeSearch = validateMediaSearch({
      view: "trash",
      folder: "folder_Abc-123_xyz",
      kind: "video",
      sort: "name-desc",
      search: `walkthrough\u0000${"x".repeat(240)}`,
    });
    const workspace = mediaRouteSearchToWorkspaceState(routeSearch);

    expect(routeSearch.search).not.toContain("\u0000");
    expect(routeSearch.search).toHaveLength(200);
    expect(workspace).toMatchObject({
      view: "trash",
      folderId: "folder_Abc-123_xyz",
      kind: "video",
      sortBy: "filename",
      sortOrder: "desc",
    });
  });

  it("omits defaults while preserving a meaningful workspace address", () => {
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
      search: undefined,
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
      search: "campaign",
    });
  });
});
