import { describe, expect, it } from "vitest";

import { getAdminScrollRestorationKey } from "./admin-scroll-restoration";

describe("admin scroll restoration", () => {
  it("keys settings workspaces by their addressable tab state", () => {
    expect(
      getAdminScrollRestorationKey({
        pathname: "/admin/settings",
        searchStr: "?section=seo",
        state: { __TSR_key: "history-entry-a" },
      }),
    ).toBe("settings:/admin/settings?section=seo");

    expect(
      getAdminScrollRestorationKey({
        pathname: "/admin/settings",
        searchStr: "?section=currency",
        state: { __TSR_key: "history-entry-b" },
      }),
    ).toBe("settings:/admin/settings?section=currency");
  });

  it("keeps ordinary routes scoped to their browser history entry", () => {
    expect(
      getAdminScrollRestorationKey({
        pathname: "/admin/orders",
        searchStr: "?status=pending",
        state: { __TSR_key: "history-entry-c" },
      }),
    ).toBe("history-entry-c");
  });
});
