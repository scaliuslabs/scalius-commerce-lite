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
  bulkActivateWidgets,
  bulkDeleteWidgets,
  createWidget,
  createHistoryEntry,
  deleteWidget,
  listWidgetPlacementTargets,
  restoreWidgets,
  updateWidget,
} from "../../../../packages/core/src/modules/widgets/widgets.service";
import { createMockDb } from "../../../setup";

function createQueuedSelectDb(results: unknown[]) {
  const queue = [...results];
  const calls: Array<{ method: string; args: unknown[] }> = [];

  const chainable = (method: string, result: unknown) => {
    const chain: Record<string, (...args: unknown[]) => unknown> & {
      get?: () => unknown;
      then?: (resolve: (value: unknown) => void) => Promise<void>;
    } = {};
    for (const m of [
      "from",
      "where",
      "set",
      "values",
      "returning",
      "orderBy",
      "limit",
      "offset",
      "innerJoin",
      "leftJoin",
    ]) {
      chain[m] = (...args: unknown[]) => {
        calls.push({ method: `${method}.${m}`, args });
        return chain;
      };
    }
    chain.get = () => {
      calls.push({ method: `${method}.get`, args: [] });
      return result ?? null;
    };
    chain.then = (resolve: (value: unknown) => void) => {
      const value = Array.isArray(result) ? result : result ? [result] : [];
      return Promise.resolve(value).then(resolve);
    };
    return chain;
  };

  return {
    select: vi.fn((...args: unknown[]) => {
      calls.push({ method: "select", args });
      return chainable("select", queue.shift());
    }),
    update: vi.fn((...args: unknown[]) => {
      calls.push({ method: "update", args });
      return chainable("update", []);
    }),
    insert: vi.fn((...args: unknown[]) => {
      calls.push({ method: "insert", args });
      return chainable("insert", [{ id: "mock-id" }]);
    }),
    delete: vi.fn((...args: unknown[]) => {
      calls.push({ method: "delete", args });
      return chainable("delete", undefined);
    }),
    batch: vi.fn(async (stmts: unknown[]) => {
      calls.push({ method: "batch", args: stmts });
      return stmts.map(() => []);
    }),
    _calls: calls,
  };
}

describe("widget placement persistence", () => {
  it("hydrates selected placement targets without duplicating search results", async () => {
    const db = createMockDb({
      selectResult: [{ id: "prod_1", label: "Fish", description: "fish" }],
    }) as any;

    const targets = await listWidgetPlacementTargets(db, {
      targetType: "product",
      search: "fish",
      selectedIds: ["prod_1"],
      limit: 20,
    });

    expect(targets).toEqual([
      {
        id: "prod_1",
        label: "Fish",
        description: "fish",
        type: "product",
      },
    ]);
  });

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

  it("allows incomplete widget edits only while the widget remains inactive", async () => {
    const existingWidget = {
      id: "wid_draft",
      name: "Campaign draft",
      htmlContent: "<section>Old</section>",
      cssContent: "",
      aiContext: null,
      isActive: false,
      displayTarget: "homepage",
      placementRule: WidgetPlacementRule.STANDALONE,
      referenceCollectionId: null,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      placements: [],
    };
    const db = createMockDb({ selectResult: existingWidget }) as any;

    await expect(
      updateWidget(db, "wid_draft", {
        htmlContent: "",
        isActive: false,
        placements: [],
      }),
    ).resolves.toBeTruthy();
  });

  it("rejects activation when final content is missing", async () => {
    const existingWidget = {
      id: "wid_draft",
      name: "Campaign draft",
      htmlContent: "<section>Old</section>",
      cssContent: "",
      aiContext: null,
      isActive: false,
      displayTarget: "homepage",
      placementRule: WidgetPlacementRule.STANDALONE,
      referenceCollectionId: null,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      placements: [],
    };
    const db = createMockDb({ selectResult: existingWidget }) as any;

    await expect(
      updateWidget(db, "wid_draft", {
        htmlContent: "",
        isActive: true,
        placements: [],
      }),
    ).rejects.toThrow("HTML content is required before publishing a widget.");
  });

  it("allows publishing a shortcode-only widget without placements", async () => {
    const existingWidget = {
      id: "wid_draft",
      name: "Campaign draft",
      htmlContent: "<section>Old</section>",
      cssContent: "",
      aiContext: null,
      isActive: false,
      displayTarget: "homepage",
      placementRule: WidgetPlacementRule.STANDALONE,
      referenceCollectionId: null,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      placements: [],
    };
    const db = createMockDb({ selectResult: existingWidget }) as any;

    await expect(
      updateWidget(db, "wid_draft", {
        htmlContent: "<section>Use me with a shortcode</section>",
        isActive: true,
        placements: [],
      }),
    ).resolves.toBeTruthy();

    const placementInsert = db._calls
      .filter((call: { method: string }) => call.method === "insert.values")
      .map((call: { args: unknown[] }) => call.args[0])
      .find(Array.isArray);
    expect(placementInsert).toBeUndefined();
  });

  it("rejects activating an existing widget with stale placement targets", async () => {
    const existingWidget = {
      id: "wid_stale",
      name: "Product promo",
      htmlContent: "<section>Promo</section>",
      cssContent: "",
      aiContext: null,
      isActive: false,
      displayTarget: "homepage",
      placementRule: WidgetPlacementRule.STANDALONE,
      referenceCollectionId: null,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
    };
    const stalePlacement = {
      id: "wpl_stale",
      widgetId: "wid_stale",
      scope: WidgetPlacementScope.PRODUCT,
      scopeId: "prod_missing",
      slot: WidgetPlacementSlot.TOP,
      anchorType: null,
      anchorId: null,
      sortOrder: 0,
      isActive: true,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
    };
    const db = createQueuedSelectDb([existingWidget, [stalePlacement], []]) as any;

    await expect(
      updateWidget(db, "wid_stale", {
        isActive: true,
      }),
    ).rejects.toThrow("missing or inactive products");

    expect(db.update).not.toHaveBeenCalled();
  });

  it("rejects bulk activation when existing placements have stale targets", async () => {
    const existingWidget = {
      id: "wid_bulk_stale",
      name: "Bulk Product promo",
      htmlContent: "<section>Promo</section>",
      isActive: false,
    };
    const stalePlacement = {
      id: "wpl_bulk_stale",
      widgetId: "wid_bulk_stale",
      scope: WidgetPlacementScope.PRODUCT,
      scopeId: "prod_missing",
      slot: WidgetPlacementSlot.TOP,
      anchorType: null,
      anchorId: null,
      sortOrder: 0,
      isActive: true,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
    };
    const db = createQueuedSelectDb([[existingWidget], [stalePlacement], []]) as any;

    await expect(
      bulkActivateWidgets(db, ["wid_bulk_stale"]),
    ).rejects.toThrow("missing or inactive products");

    expect(db.update).not.toHaveBeenCalled();
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

  it("rejects collection scoped widgets that do not reference an active collection", async () => {
    const db = createMockDb({ selectResult: [] }) as any;

    await expect(
      createWidget(db, {
        name: "Collection page hero",
        htmlContent: "<section>Hero</section>",
        isActive: true,
        displayTarget: "homepage",
        placementRule: WidgetPlacementRule.STANDALONE,
        referenceCollectionId: null,
        sortOrder: 0,
        placements: [
          {
            scope: WidgetPlacementScope.COLLECTION,
            scopeId: "col_missing",
            slot: WidgetPlacementSlot.TOP,
            sortOrder: 0,
            isActive: true,
          },
        ],
      }),
    ).rejects.toThrow("missing or inactive collections");

    expect(db._calls.some((call: { method: string }) => call.method === "insert.values")).toBe(false);
  });

  it("persists embedded style tags as css content instead of dropping them on save", async () => {
    const createdWidget = {
      id: "wid_created",
      name: "Styled widget",
      htmlContent: '<section class="promo"><h2>Deal</h2></section>',
      cssContent: ".promo{color:red}",
      isActive: false,
      displayTarget: "homepage",
      placementRule: WidgetPlacementRule.STANDALONE,
      referenceCollectionId: null,
      sortOrder: 0,
      aiContext: null,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      placements: [],
    };
    const db = createMockDb({ selectResult: createdWidget }) as any;

    await createWidget(db, {
      name: "Styled widget",
      htmlContent: '<section class="promo"><style>.promo { color: red; }</style><h2>Deal</h2></section>',
      isActive: false,
      displayTarget: "homepage",
      placementRule: WidgetPlacementRule.STANDALONE,
      referenceCollectionId: null,
      sortOrder: 0,
      placements: [],
    });

    const widgetInsert = db._calls
      .filter((call: { method: string }) => call.method === "insert.values")
      .map((call: { args: unknown[] }) => call.args[0])
      .find((value: unknown) => !Array.isArray(value)) as Record<string, unknown>;

    expect(widgetInsert.htmlContent).toContain('<section class="promo">');
    expect(widgetInsert.htmlContent).not.toContain("<style>");
    expect(widgetInsert.cssContent).toContain(".promo{color:red}");
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

  it("rejects widget CSS that cannot render after sanitization", async () => {
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
    const db = createMockDb({ selectResult: existingWidget }) as any;

    await expect(
      updateWidget(db, "wid_1", {
        cssContent: ".broken[ { color: red; }",
      }),
    ).rejects.toThrow(/CSS/i);
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
