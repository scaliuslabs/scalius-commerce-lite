import { describe, expect, it } from "vitest";
import {
  WidgetPlacementAnchorType,
  WidgetPlacementRule,
  WidgetPlacementScope,
  WidgetPlacementSlot,
} from "../../../../packages/database/src/schema";
import {
  createWidgetSchema,
  updateWidgetSchema,
  widgetPlacementInputSchema,
} from "../../../../packages/core/src/modules/widgets/widgets.validation";

describe("widget placement validation", () => {
  it("accepts a reusable page-scoped placement", () => {
    const placement = widgetPlacementInputSchema.parse({
      scope: WidgetPlacementScope.PAGE,
      scopeId: "page_launch",
      slot: WidgetPlacementSlot.BEFORE_CONTENT,
      sortOrder: 2,
    });

    expect(placement).toMatchObject({
      scope: WidgetPlacementScope.PAGE,
      scopeId: "page_launch",
      slot: WidgetPlacementSlot.BEFORE_CONTENT,
    });
  });

  it("requires scopeId for non-homepage placements", () => {
    const result = widgetPlacementInputSchema.safeParse({
      scope: WidgetPlacementScope.PAGE,
      slot: WidgetPlacementSlot.TOP,
    });

    expect(result.success).toBe(false);
  });

  it("requires a collection anchor for collection slots", () => {
    const result = widgetPlacementInputSchema.safeParse({
      scope: WidgetPlacementScope.HOMEPAGE,
      slot: WidgetPlacementSlot.BEFORE_COLLECTION,
      anchorType: WidgetPlacementAnchorType.CONTENT,
      anchorId: "col_1",
    });

    expect(result.success).toBe(false);
  });

  it("rejects homepage placements with page scope IDs", () => {
    const result = widgetPlacementInputSchema.safeParse({
      scope: WidgetPlacementScope.HOMEPAGE,
      scopeId: "page_launch",
      slot: WidgetPlacementSlot.TOP,
    });

    expect(result.success).toBe(false);
  });

  it("rejects anchor fields on non-collection slots", () => {
    const result = widgetPlacementInputSchema.safeParse({
      scope: WidgetPlacementScope.HOMEPAGE,
      slot: WidgetPlacementSlot.TOP,
      anchorType: WidgetPlacementAnchorType.COLLECTION,
      anchorId: "col_1",
    });

    expect(result.success).toBe(false);
  });

  it("rejects duplicate canonical placement targets", () => {
    const result = createWidgetSchema.safeParse({
      name: "Homepage Hero",
      htmlContent: "<section>Hero</section>",
      placements: [
        {
          scope: WidgetPlacementScope.HOMEPAGE,
          slot: WidgetPlacementSlot.TOP,
          sortOrder: 1,
        },
        {
          scope: WidgetPlacementScope.HOMEPAGE,
          slot: WidgetPlacementSlot.TOP,
          sortOrder: 2,
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rejects page content slots on homepage placements", () => {
    const result = widgetPlacementInputSchema.safeParse({
      scope: WidgetPlacementScope.HOMEPAGE,
      slot: WidgetPlacementSlot.BEFORE_CONTENT,
    });

    expect(result.success).toBe(false);
  });

  it("rejects collection list slots on scoped page placements", () => {
    const result = widgetPlacementInputSchema.safeParse({
      scope: WidgetPlacementScope.PAGE,
      scopeId: "page_launch",
      slot: WidgetPlacementSlot.AFTER_COLLECTION,
      anchorType: WidgetPlacementAnchorType.COLLECTION,
      anchorId: "col_1",
    });

    expect(result.success).toBe(false);
  });

  it("keeps the existing single-placement form contract valid", () => {
    const widget = createWidgetSchema.parse({
      name: "Homepage Hero",
      htmlContent: "<section>Hero</section>",
      cssContent: "",
      isActive: true,
      displayTarget: "homepage",
      placementRule: WidgetPlacementRule.BEFORE_COLLECTION,
      referenceCollectionId: "col_1",
      sortOrder: 1,
    });

    expect(widget.placementRule).toBe(WidgetPlacementRule.BEFORE_COLLECTION);
  });

  it("rejects legacy-only placement updates", () => {
    const result = updateWidgetSchema.safeParse({
      placementRule: WidgetPlacementRule.FIXED_BOTTOM_HOMEPAGE,
      sortOrder: 5,
    });

    expect(result.success).toBe(false);
  });
});
