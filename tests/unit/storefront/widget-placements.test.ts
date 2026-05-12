import { describe, expect, it } from "vitest";
import { getWidgetsForZone } from "../../../apps/storefront/src/lib/widget-placements";
import type { ApiWidget } from "../../../apps/storefront/src/lib/api/types";

function widget(
  id: string,
  placement: NonNullable<ApiWidget["placements"]>[number],
): ApiWidget {
  return {
    id,
    name: id,
    htmlContent: `<section>${id}</section>`,
    cssContent: "",
    isActive: true,
    displayTarget: "homepage",
    placementRule: "standalone",
    sortOrder: 0,
    placements: [placement],
    createdAt: "1",
    updatedAt: "1",
    deletedAt: null,
  };
}

describe("widget placement grouping", () => {
  it("selects and sorts homepage collection-anchored widgets by canonical placement rows", () => {
    const widgets = [
      widget("second", {
        id: "wpl_2",
        widgetId: "second",
        scope: "homepage",
        scopeId: null,
        slot: "before_collection",
        anchorType: "collection",
        anchorId: "col_1",
        sortOrder: 20,
        isActive: true,
      }),
      widget("first", {
        id: "wpl_1",
        widgetId: "first",
        scope: "homepage",
        scopeId: null,
        slot: "before_collection",
        anchorType: "collection",
        anchorId: "col_1",
        sortOrder: 10,
        isActive: true,
      }),
      widget("other-collection", {
        id: "wpl_3",
        widgetId: "other-collection",
        scope: "homepage",
        scopeId: null,
        slot: "before_collection",
        anchorType: "collection",
        anchorId: "col_2",
        sortOrder: 1,
        isActive: true,
      }),
    ];

    expect(
      getWidgetsForZone(widgets, {
        scope: "homepage",
        slot: "before_collection",
        anchorId: "col_1",
      }).map((item) => item.id),
    ).toEqual(["first", "second"]);
  });

  it("matches page placements by page id and ignores inactive placements", () => {
    const widgets = [
      widget("landing", {
        id: "wpl_page",
        widgetId: "landing",
        scope: "page",
        scopeId: "page_1",
        slot: "before_content",
        anchorType: null,
        anchorId: null,
        sortOrder: 1,
        isActive: true,
      }),
      widget("disabled", {
        id: "wpl_disabled",
        widgetId: "disabled",
        scope: "page",
        scopeId: "page_1",
        slot: "before_content",
        anchorType: null,
        anchorId: null,
        sortOrder: 0,
        isActive: false,
      }),
    ];

    expect(
      getWidgetsForZone(widgets, {
        scope: "page",
        scopeId: "page_1",
        slot: "before_content",
      }).map((item) => item.id),
    ).toEqual(["landing"]);
  });
});
