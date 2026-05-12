import { describe, expect, it } from "vitest";
import {
    WidgetPlacementRule,
    WidgetPlacementScope,
    WidgetPlacementSlot,
} from "@scalius/database/schema";
import { createWidgetSchema, updateWidgetSchema } from "./widgets.validation";

const placement = {
    scope: WidgetPlacementScope.HOMEPAGE,
    scopeId: null,
    slot: WidgetPlacementSlot.TOP,
    anchorType: null,
    anchorId: null,
    sortOrder: 0,
    isActive: true,
};

describe("widget placement validation", () => {
    it("treats canonical placements as authoritative over stale legacy fields", () => {
        const parsed = createWidgetSchema.parse({
            name: "Homepage Hero",
            htmlContent: "<section>Hero</section>",
            cssContent: "",
            isActive: true,
            displayTarget: "homepage",
            placementRule: WidgetPlacementRule.BEFORE_COLLECTION,
            referenceCollectionId: null,
            sortOrder: 99,
            placements: [placement],
        });

        expect(parsed.placements).toEqual([placement]);
    });

    it("allows an explicit empty placement list for shortcode-only widgets", () => {
        const parsed = updateWidgetSchema.parse({
            placementRule: WidgetPlacementRule.BEFORE_COLLECTION,
            referenceCollectionId: null,
            placements: [],
        });

        expect(parsed.placements).toEqual([]);
    });

    it("still rejects legacy collection placement fields without a collection", () => {
        const result = createWidgetSchema.safeParse({
            name: "Homepage Hero",
            htmlContent: "<section>Hero</section>",
            placementRule: WidgetPlacementRule.BEFORE_COLLECTION,
            referenceCollectionId: null,
        });

        expect(result.success).toBe(false);
    });

    it("accepts product placements because product pages render scoped widgets", () => {
        const parsed = createWidgetSchema.parse({
            name: "Product Promo",
            htmlContent: "<section>Product promo</section>",
            placements: [{
                ...placement,
                scope: WidgetPlacementScope.PRODUCT,
                scopeId: "prod_123",
                slot: WidgetPlacementSlot.BEFORE_CONTENT,
            }],
        });

        expect(parsed.placements?.[0]?.scope).toBe(WidgetPlacementScope.PRODUCT);
    });
});
