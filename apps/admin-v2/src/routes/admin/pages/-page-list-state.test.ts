import { describe, expect, it } from "vitest";
import {
  pageListQueryParams,
  validatePageSearch,
} from "./-page-list-state";

describe("page list route state", () => {
  it("keeps valid lifecycle filters and canonicalizes unsafe list values", () => {
    expect(validatePageSearch({
      page: "2.8",
      limit: "999",
      sort: "sortOrder",
      order: "sideways",
      status: "scheduled",
    } as never)).toEqual({
      page: 2,
      limit: 100,
      search: "",
      sort: "updatedAt",
      order: "desc",
      trashed: false,
      status: "scheduled",
    });
  });

  it("drops unknown statuses and never applies lifecycle filters to trash", () => {
    expect(validatePageSearch({ status: "waiting" } as never).status).toBeUndefined();

    const trashSearch = validatePageSearch({
      trashed: "true",
      status: "published",
    } as never);
    expect(pageListQueryParams(trashSearch)).toMatchObject({
      showTrashed: true,
      status: undefined,
    });
  });
});
