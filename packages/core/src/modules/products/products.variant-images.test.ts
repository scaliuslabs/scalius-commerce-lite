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
                imageId: "img_cotton",
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
        if (result.success) expect(result.data.variants[0]!.imageId).toBe("img_cotton");
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
                    imageId: "img_white",
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
            expect(result.data.variants.map((variant) => variant.imageId)).toEqual(["img_white", null]);
        }
    });

    it("rejects a concrete SKU image owned by another product", () => {
        expect(() => assertVariantImageOwnership(
            "img_other_product",
            new Set(["img_this_product"]),
        )).toThrow(ValidationError);
    });
});
