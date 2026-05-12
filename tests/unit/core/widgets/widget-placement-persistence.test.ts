import { describe, expect, it } from "vitest";
import {
  WidgetPlacementRule,
  WidgetPlacementScope,
  WidgetPlacementSlot,
} from "../../../../packages/database/src/schema";
import { updateWidget } from "../../../../packages/core/src/modules/widgets/widgets.service";
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
