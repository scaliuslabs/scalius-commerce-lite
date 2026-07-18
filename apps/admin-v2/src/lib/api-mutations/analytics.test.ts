import { describe, expect, it } from "vitest";
import type { AnalyticsScriptsListResponse } from "~/types/api-responses";
import { removeAnalyticsScriptFromListPage } from "./analytics";

function listPage(): AnalyticsScriptsListResponse {
  return {
    scripts: [
      {
        id: "analytics_one",
        name: "Storefront analytics",
        type: "google_analytics",
        isActive: false,
        usePartytown: true,
        location: "head",
        revision: 2,
        createdAt: "2026-07-19T00:00:00.000Z",
        updatedAt: "2026-07-19T00:00:00.000Z",
        deletedAt: null,
        identifier: "G-TEST",
        readiness: "draft",
        configIssue: null,
      },
    ],
    pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
  };
}

describe("analytics list cache reconciliation", () => {
  it("removes a lifecycle-moved script before showing success", () => {
    expect(removeAnalyticsScriptFromListPage(listPage(), "analytics_one")).toEqual({
      scripts: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });
  });

  it("preserves unrelated cached pages by reference", () => {
    const current = listPage();
    expect(removeAnalyticsScriptFromListPage(current, "analytics_other")).toBe(current);
  });
});
