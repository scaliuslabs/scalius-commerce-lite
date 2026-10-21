import { describe, expect, it } from "vitest";

import { MAX_MAJOR_AMOUNT } from "@scalius/shared/money";
import {
    createVariantSchema,
    updateVariantSchema,
} from "./types";
import { productOptionMatrixSchema } from "../product-admin/option-matrix";

const validVariant = {
    selectedOptionValueIds: ["value_m"],
    imageId: null,
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
        ["create", (price: number) => createVariantSchema.safeParse({ ...validVariant, price, expectedAggregateRevision: 1 })],
        ["update", (price: number) => updateVariantSchema.safeParse({ ...validVariant, price, expectedStockVersion: 1, expectedAggregateRevision: 1 })],
        ["option matrix", (price: number) => productOptionMatrixSchema.safeParse({
            options: [{
                id: "option_size",
                name: "Size",
                standardMapping: "size",
                values: [{ id: "value_m", value: "M" }],
            }],
            variants: [{ ...validVariant, id: "variant_m", price }],
            expectedAggregateRevision: 1,
        })],
    ] as const)("caps %s prices at the money ceiling of any currency", (_label, parse) => {
        expect(parse(MAX_MAJOR_AMOUNT).success).toBe(true);
        expect(parse(MAX_MAJOR_AMOUNT + 1).success).toBe(false);
        expect(parse(1e21).success).toBe(false);
    });
});
