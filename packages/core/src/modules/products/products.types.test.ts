import { describe, expect, it } from "vitest";

import {
    MAX_PRODUCT_PRICE,
    bulkCreateVariantsSchema,
    bulkUpdateVariantsSchema,
    createVariantSchema,
    updateVariantSchema,
} from "./products.types";

const validVariant = {
    size: "M",
    color: null,
    weight: null,
    sku: "SKU-001",
    price: 100,
    stock: 5,
    trackInventory: true,
    barcode: null,
    barcodeType: null,
    discountType: "percentage" as const,
    discountPercentage: 0,
    discountAmount: null,
};

describe("variant price input boundaries", () => {
    it.each([
        ["create", (price: number) => createVariantSchema.safeParse({ ...validVariant, price })],
        ["update", (price: number) => updateVariantSchema.safeParse({ ...validVariant, price })],
        ["bulk create", (price: number) => bulkCreateVariantsSchema.safeParse({
            variants: [{
                ...validVariant,
                price,
                colorSortOrder: 0,
                sizeSortOrder: 0,
            }],
        })],
        ["bulk update", (price: number) => bulkUpdateVariantsSchema.safeParse({
            updates: [{ id: "var_1", price }],
        })],
    ] as const)("caps %s prices at the product price maximum", (_label, parse) => {
        expect(parse(MAX_PRODUCT_PRICE).success).toBe(true);
        expect(parse(1e21).success).toBe(false);
    });
});
