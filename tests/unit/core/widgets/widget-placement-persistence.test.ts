import { describe, expect, it, vi } from "vitest";
import {
  widgets,
  widgetPlacements,
  WidgetPlacementAnchorType,
  WidgetPlacementRule,
  WidgetPlacementScope,
  WidgetPlacementSlot,
} from "../../../../packages/database/src/schema";
import {
  bulkDeleteWidgets,
  createWidget,
  createHistoryEntry,
  deleteWidget,
  restoreWidgets,
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

    const deleteTargets = db._calls
      .filter((call: { method: string }) => call.method === "delete")
      .map((call: { args: unknown[] }) => call.args[0]);
    expect(deleteTargets).toContain(widgetPlacements);
    expect(
      db._calls.some((call: { method: string }) => call.method === "update.set"
        && typeof call.args[0] === "object"
        && call.args[0] !== null
        && "deletedAt" in call.args[0]
      ),
    ).toBe(false);
  });

  it("rejects projected legacy fields without canonical placements", async () => {
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

    await expect(
      updateWidget(db, "wid_1", {
        placementRule: WidgetPlacementRule.FIXED_BOTTOM_HOMEPAGE,
        referenceCollectionId: null,
        sortOrder: 9,
      }),
    ).rejects.toThrow("Use canonical placements to change widget placement.");

    expect(db._calls.some((call: { method: string }) => call.method === "delete")).toBe(false);
    expect(
      db._calls
        .filter((call: { method: string }) => call.method === "insert.values")
        .map((call: { args: unknown[] }) => call.args[0])
        .some(Array.isArray),
    ).toBe(false);
  });

  it("rejects collection placements that do not reference an active collection", async () => {
    const db = createMockDb({ selectResult: [] }) as any;

    await expect(
      createWidget(db, {
        name: "Collection promo",
        htmlContent: "<section>Promo</section>",
        isActive: true,
        displayTarget: "homepage",
        placementRule: WidgetPlacementRule.STANDALONE,
        referenceCollectionId: null,
        sortOrder: 0,
        placements: [
          {
            scope: WidgetPlacementScope.HOMEPAGE,
            slot: WidgetPlacementSlot.BEFORE_COLLECTION,
            anchorType: WidgetPlacementAnchorType.COLLECTION,
            anchorId: "col_missing",
            sortOrder: 0,
            isActive: true,
          },
        ],
      }),
    ).rejects.toThrow("missing or inactive collections");

    expect(db._calls.some((call: { method: string }) => call.method === "insert.values")).toBe(false);
  });
});

describe("widget restore persistence", () => {
  it("uses the same deletion timestamp for widgets and active placements", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T03:04:05Z"));
    const deletedAt = new Date("2026-01-02T03:04:05Z");
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
      placements: [],
    };
    const db = createMockDb({ selectResult: existingWidget }) as any;

    try {
      await deleteWidget(db, "wid_1");

      const setPayloads = db._calls
        .filter((call: { method: string }) => call.method === "update.set")
        .map((call: { args: unknown[] }) => call.args[0]);

      expect(setPayloads).toEqual([
        { deletedAt, updatedAt: deletedAt },
        { deletedAt, updatedAt: deletedAt },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bulk soft delete uses the same deletion timestamp for widgets and active placements", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T03:04:05Z"));
    const deletedAt = new Date("2026-01-02T03:04:05Z");
    const db = createMockDb() as any;

    try {
      await bulkDeleteWidgets(db, ["wid_1", "wid_2"]);

      const setPayloads = db._calls
        .filter((call: { method: string }) => call.method === "update.set")
        .map((call: { args: unknown[] }) => call.args[0]);

      expect(setPayloads).toEqual([
        { deletedAt, updatedAt: deletedAt },
        { deletedAt, updatedAt: deletedAt },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores only placements deleted with the widget", async () => {
    const db = createMockDb() as any;

    await restoreWidgets(db, ["wid_1", "wid_2"]);

    const updateTargets = db._calls
      .filter((call: { method: string }) => call.method === "update")
      .map((call: { args: unknown[] }) => call.args[0]);

    expect(updateTargets).toEqual([widgetPlacements, widgets]);
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
    expect(historyInsert.cssContent).toContain(".draft{color:red}");
    expect(historyInsert.cssContent).not.toContain("@import");
    expect(historyInsert.cssContent).not.toContain(".published");
  });
});
