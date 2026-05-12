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

  it("accepts product and category scoped content placements", () => {
    const productPlacement = widgetPlacementInputSchema.parse({
      scope: WidgetPlacementScope.PRODUCT,
      scopeId: "prod_1",
      slot: WidgetPlacementSlot.AFTER_CONTENT,
    });
    const categoryPlacement = widgetPlacementInputSchema.parse({
      scope: WidgetPlacementScope.CATEGORY,
      scopeId: "cat_1",
      slot: WidgetPlacementSlot.BEFORE_CONTENT,
    });

    expect(productPlacement).toMatchObject({
      scope: WidgetPlacementScope.PRODUCT,
      scopeId: "prod_1",
      slot: WidgetPlacementSlot.AFTER_CONTENT,
    });
    expect(categoryPlacement).toMatchObject({
      scope: WidgetPlacementScope.CATEGORY,
      scopeId: "cat_1",
      slot: WidgetPlacementSlot.BEFORE_CONTENT,
    });
  });

  it("accepts collection scoped content placements", () => {
    const placement = widgetPlacementInputSchema.parse({
      scope: WidgetPlacementScope.COLLECTION,
      scopeId: "col_1",
      slot: WidgetPlacementSlot.BEFORE_CONTENT,
    });

    expect(placement).toMatchObject({
      scope: WidgetPlacementScope.COLLECTION,
      scopeId: "col_1",
      slot: WidgetPlacementSlot.BEFORE_CONTENT,
    });
  });

  it("requires scopeId for non-homepage placements", () => {
    const result = widgetPlacementInputSchema.safeParse({
      scope: WidgetPlacementScope.PRODUCT,
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

  it("allows inactive drafts without final HTML or placements", () => {
    const widget = createWidgetSchema.parse({
      name: "Launch Draft",
      htmlContent: "",
      isActive: false,
      placements: [],
    });

    expect(widget.isActive).toBe(false);
    expect(widget.htmlContent).toBe("");
    expect(widget.placements).toEqual([]);
  });

  it("requires HTML before publishing", () => {
    const result = createWidgetSchema.safeParse({
      name: "Launch Draft",
      htmlContent: " ",
      isActive: true,
      placements: [],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("htmlContent");
      expect(paths).not.toContain("placements");
    }
  });

  it("allows active shortcode-only widgets without placements", () => {
    const widget = createWidgetSchema.parse({
      name: "Shortcode Promo",
      htmlContent: "<section>Promo</section>",
      isActive: true,
      placements: [],
    });

    expect(widget.placements).toEqual([]);
    expect(widget.isActive).toBe(true);
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
