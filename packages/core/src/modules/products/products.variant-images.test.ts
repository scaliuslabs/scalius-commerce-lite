import { describe, expect, it } from "vitest";
import { ValidationError } from "@scalius/core/errors";
import {
    assertVariantImageOwnership,
    productOptionMatrixSchema,
} from "./products.option-matrix";

describe("normalized option-matrix image ownership", () => {
    it("keeps image selection on each concrete SKU row", () => {
        const result = productOptionMatrixSchema.safeParse({
            options: [{
                id: "option_fabric",
                name: "Fabric",
                standardMapping: "material",
                values: [{ id: "value_cotton", value: "Cotton" }],
            }],
            variants: [{
                id: "variant_cotton",
                selectedOptionValueIds: ["value_cotton"],
                imageId: "pmed_cotton",
                sku: "FABRIC-COTTON",
                price: 500,
                stock: 3,
                trackInventory: true,
                weight: null,
                barcode: null,
                barcodeType: null,
                discountType: "percentage",
                discountPercentage: null,
                discountAmount: null,
            }],
            expectedAggregateRevision: 1,
        });

        expect(result.success).toBe(true);
        if (result.success) expect(result.data.variants[0]!.imageId).toBe("pmed_cotton");
    });

    it("accepts a partial matrix where only some SKUs have an exact image", () => {
        const result = productOptionMatrixSchema.safeParse({
            options: [{
                id: "option_color",
                name: "Color",
                standardMapping: "color",
                values: [
                    { id: "value_white", value: "White" },
                    { id: "value_black", value: "Black" },
                ],
            }],
            variants: [
                {
                    id: "variant_white",
                    selectedOptionValueIds: ["value_white"],
                    imageId: "pmed_white",
                    sku: "COLOR-WHITE",
                    price: 500,
                    stock: 3,
                    trackInventory: true,
                    weight: null,
                    barcode: null,
                    barcodeType: null,
                    discountType: "percentage",
                    discountPercentage: null,
                    discountAmount: null,
                },
                {
                    id: "variant_black",
                    selectedOptionValueIds: ["value_black"],
                    imageId: null,
                    sku: "COLOR-BLACK",
                    price: 500,
                    stock: 3,
                    trackInventory: true,
                    weight: null,
                    barcode: null,
                    barcodeType: null,
                    discountType: "percentage",
                    discountPercentage: null,
                    discountAmount: null,
                },
            ],
            expectedAggregateRevision: 1,
        });

        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.variants.map((variant) => variant.imageId)).toEqual(["pmed_white", null]);
        }
    });

    it("rejects a concrete SKU image owned by another product", () => {
        expect(() => assertVariantImageOwnership(
            "pmed_other_product",
            new Map([["pmed_this_product", { status: "ready" as const }]]),
        )).toThrow(ValidationError);
    });

    it("allows only an unchanged SKU assignment to retain a trashed exact image", () => {
        const associations = new Map([
            ["pmed_trashed", { status: "trashed" as const }],
        ]);
        expect(() => assertVariantImageOwnership(
            "pmed_trashed",
            associations,
            "pmed_trashed",
        )).not.toThrow();
        expect(() => assertVariantImageOwnership(
            "pmed_trashed",
            associations,
            null,
        )).toThrow(ValidationError);
    });
});
