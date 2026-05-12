import { describe, expect, it } from "vitest";
import {
  WidgetPlacementRule,
  WidgetPlacementScope,
  WidgetPlacementSlot,
} from "../../../../packages/database/src/schema";
import {
  createHistoryEntry,
  updateWidget,
} from "../../../../packages/core/src/modules/widgets/widgets.service";
import { createMockDb } from "../../../setup";

describe("widget placement persistence", () => {
  it("generates fresh placement row ids when replacing placements", async () => {
    const existingWidget = {
      id: "wid_1",
      name: "Landing hero",
      htmlContent: "<section>Hero</section>",
      cssContent: "",
      aiContext: null,
      isActive: true,
      displayTarget: "homepage",
      placementRule: WidgetPlacementRule.FIXED_TOP_HOMEPAGE,
      referenceCollectionId: null,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      placements: [
        {
          id: "wpl_existing",
          widgetId: "wid_1",
          scope: WidgetPlacementScope.HOMEPAGE,
          scopeId: null,
          slot: WidgetPlacementSlot.TOP,
          anchorType: null,
          anchorId: null,
          sortOrder: 0,
          isActive: true,
          createdAt: 1,
          updatedAt: 1,
          deletedAt: null,
        },
      ],
    };
    const db = createMockDb({ selectResult: existingWidget }) as any;

    await updateWidget(db, "wid_1", {
      placements: [
        {
          id: "wpl_existing",
          scope: WidgetPlacementScope.HOMEPAGE,
          scopeId: null,
          slot: WidgetPlacementSlot.BOTTOM,
          anchorType: null,
          anchorId: null,
          sortOrder: 2,
          isActive: true,
        },
      ],
    });

    const placementInsert = db._calls
      .filter((call: { method: string }) => call.method === "insert.values")
      .map((call: { args: unknown[] }) => call.args[0])
      .find(Array.isArray) as Array<Record<string, unknown>>;

    expect(placementInsert).toHaveLength(1);
    expect(placementInsert[0]).toMatchObject({
      widgetId: "wid_1",
      scope: WidgetPlacementScope.HOMEPAGE,
      slot: WidgetPlacementSlot.BOTTOM,
      sortOrder: 2,
      deletedAt: null,
    });
    expect(placementInsert[0]?.id).toEqual(expect.stringMatching(/^wpl_/));
    expect(placementInsert[0]?.id).not.toBe("wpl_existing");
  });
});

describe("widget history persistence", () => {
  it("can snapshot the current unsaved editor content without publishing it", async () => {
    const existingWidget = {
      id: "wid_1",
      name: "Landing hero",
      htmlContent: "<section>Published</section>",
      cssContent: ".published { color: blue; }",
      aiContext: null,
      isActive: true,
      displayTarget: "homepage",
      placementRule: WidgetPlacementRule.FIXED_TOP_HOMEPAGE,
      referenceCollectionId: null,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      placements: [],
    };
    const db = createMockDb({
      selectResult: existingWidget,
      insertResult: { id: "whist_1" },
    }) as any;

    await createHistoryEntry(db, "wid_1", "Draft checkpoint", {
      htmlContent: '<section onclick="alert(1)">Draft</section><script>alert(1)</script>',
      cssContent: '@import url("https://example.com/evil.css"); .draft { color: red; }',
    });

    const historyInsert = db._calls.find(
      (call: { method: string }) => call.method === "insert.values",
    )?.args[0] as Record<string, unknown>;

    expect(historyInsert).toMatchObject({
      widgetId: "wid_1",
      reason: "Draft checkpoint",
    });
    expect(historyInsert.htmlContent).toContain("Draft");
    expect(historyInsert.htmlContent).not.toContain("onclick");
    expect(historyInsert.htmlContent).not.toContain("<script");
    expect(historyInsert.htmlContent).not.toContain("Published");
    expect(historyInsert.cssContent).toContain(".draft { color: red; }");
    expect(historyInsert.cssContent).not.toContain("@import");
    expect(historyInsert.cssContent).not.toContain(".published");
  });
});
