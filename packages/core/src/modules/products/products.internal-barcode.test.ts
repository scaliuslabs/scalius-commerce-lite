import { describe, expect, it } from "vitest";

import { defaultProductSkuValues } from "./products.public-eligibility";
import {
    normalizeVariantBarcode,
    resolveNewVariantBarcode,
} from "./products.variants";
import {
    createProductOptionMatrixSchema,
} from "./products.option-matrix";
import { generateInternalCode128Barcode } from "@scalius/shared/barcode-identity";

describe("internal SKU barcodes", () => {
    it("assigns a stable internal Code 128 identity only when a new SKU has no barcode", () => {
        expect(resolveNewVariantBarcode("var_abc-123", null, null)).toEqual({
            barcode: generateInternalCode128Barcode("var_abc-123"),
            barcodeType: "code128",
        });

        expect(resolveNewVariantBarcode(
            "var_abc-123",
            "  5901234123457  ",
            "ean13",
        )).toEqual({
            barcode: "5901234123457",
            barcodeType: "ean13",
        });
    });

    it("does not regenerate a barcode through the existing-SKU normalization path", () => {
        expect(normalizeVariantBarcode(null, null)).toEqual({
            barcode: null,
            barcodeType: null,
        });
    });

    it("gives newly created simple products the same scanner-ready identity", () => {
        expect(defaultProductSkuValues("prod_abc-123", 1250)).toMatchObject({
            id: "var_default_prod_abc-123",
            barcode: generateInternalCode128Barcode("var_default_prod_abc-123"),
            barcodeType: "code128",
        });

        const productionShape = defaultProductSkuValues(
            `prod_${"a".repeat(21)}`,
            1250,
        );
        expect(productionShape.barcode.length).toBeLessThanOrEqual(50);
    });

    it("accepts Code 128 as an explicit matrix barcode type", () => {
        expect(createProductOptionMatrixSchema.safeParse({
            options: [{
                id: "draft_option",
                name: "Pack",
                standardMapping: "none",
                values: [{ id: "draft_value", value: "Single" }],
            }],
            variants: [{
                id: "draft_variant",
                selectedOptionValueIds: ["draft_value"],
                imageId: null,
                sku: "PACK-SINGLE",
                price: 1250,
                stock: 0,
                trackInventory: true,
                weight: null,
                barcode: "SCALIUS:C128:merchant-import-1",
                barcodeType: "code128",
                discountType: "percentage",
                discountPercentage: 0,
                discountAmount: null,
            }],
        }).success).toBe(true);
    });
});
