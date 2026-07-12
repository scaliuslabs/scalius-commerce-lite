import { describe, expect, it } from "vitest";
import {
    assertOptionMatrixStockAllocation,
    assertOptionMatrixReplacementStockAllocation,
    assertVariantImageOwnership,
    orderSelectedOptionValueIds,
    parseProductOptionMatrix,
    productOptionMatrixSchema,
    type ProductOptionMatrixInput,
} from "./products.option-matrix";
import {
    MAX_PRODUCT_OPTION_AXES,
    MAX_PRODUCT_OPTION_COMBINATIONS,
} from "./products.option-model";
import { ConflictError, ValidationError } from "@scalius/core/errors";

function row(id: string, values: string[]) {
    return {
        id,
        selectedOptionValueIds: values,
        imageId: null,
        sku: `SKU-${id}`,
        price: 100,
        stock: 0,
        trackInventory: true,
        weight: null,
        barcode: null,
        barcodeType: null,
        discountType: "percentage" as const,
        discountPercentage: null,
        discountAmount: null,
    };
}

const validMatrix: ProductOptionMatrixInput = {
    options: [
        {
            id: "draft_size",
            name: "Size",
            standardMapping: "size" as const,
            values: [
                { id: "draft_small", value: "Small" },
                { id: "draft_large", value: "Large" },
            ],
        },
        {
            id: "draft_finish",
            name: "Finish",
            standardMapping: "none" as const,
            values: [
                { id: "draft_matte", value: "Matte" },
                { id: "draft_gloss", value: "Gloss" },
            ],
        },
    ],
    variants: [
        row("draft_1", ["draft_small", "draft_matte"]),
        row("draft_2", ["draft_small", "draft_gloss"]),
        row("draft_3", ["draft_large", "draft_matte"]),
        row("draft_4", ["draft_large", "draft_gloss"]),
    ],
    expectedAggregateRevision: 1,
};

describe("normalized product option matrix", () => {
    it("accepts an exact Cartesian matrix with arbitrary merchant option names", () => {
        expect(productOptionMatrixSchema.safeParse(validMatrix).success).toBe(true);
    });

    it("canonicalizes selected values by arbitrary axis order", () => {
        const options = [
            { id: "fabric", values: [{ id: "cotton" }, { id: "silk" }] },
            { id: "weave", values: [{ id: "plain" }, { id: "jamdani" }] },
            { id: "origin", values: [{ id: "tangail" }] },
        ];

        expect(orderSelectedOptionValueIds(options, ["tangail", "jamdani", "silk"]))
            .toEqual(["silk", "jamdani", "tangail"]);
    });

    it("rejects missing, duplicate, and cross-axis combinations", () => {
        const missing = structuredClone(validMatrix);
        missing.variants.pop();
        expect(productOptionMatrixSchema.safeParse(missing).success).toBe(false);

        const duplicate = structuredClone(validMatrix);
        duplicate.variants[3]!.selectedOptionValueIds = ["draft_small", "draft_matte"];
        expect(productOptionMatrixSchema.safeParse(duplicate).success).toBe(false);

        const sameAxisTwice = structuredClone(validMatrix);
        sameAxisTwice.variants[0]!.selectedOptionValueIds = ["draft_small", "draft_large"];
        expect(productOptionMatrixSchema.safeParse(sameAxisTwice).success).toBe(false);
    });

    it("rejects normalized duplicate option names, values, SKUs, and barcodes", () => {
        const duplicateNames = structuredClone(validMatrix);
        duplicateNames.options[1]!.name = " size ";
        expect(productOptionMatrixSchema.safeParse(duplicateNames).success).toBe(false);

        const duplicateValues = structuredClone(validMatrix);
        duplicateValues.options[0]!.values[1]!.value = " small ";
        expect(productOptionMatrixSchema.safeParse(duplicateValues).success).toBe(false);

        const duplicateSkus = structuredClone(validMatrix);
        duplicateSkus.variants[1]!.sku = duplicateSkus.variants[0]!.sku.toLowerCase();
        expect(productOptionMatrixSchema.safeParse(duplicateSkus).success).toBe(false);

        const duplicateBarcodes = structuredClone(validMatrix);
        duplicateBarcodes.variants[0]!.barcode = "ABC-1";
        duplicateBarcodes.variants[0]!.barcodeType = "custom";
        duplicateBarcodes.variants[1]!.barcode = "abc-1";
        duplicateBarcodes.variants[1]!.barcodeType = "custom";
        expect(productOptionMatrixSchema.safeParse(duplicateBarcodes).success).toBe(false);
    });

    it("allows unmapped axes but rejects duplicate standard mappings", () => {
        const duplicateMapping = structuredClone(validMatrix);
        duplicateMapping.options[1]!.standardMapping = "size";
        expect(productOptionMatrixSchema.safeParse(duplicateMapping).success).toBe(false);

        const noMappings = structuredClone(validMatrix);
        noMappings.options[0]!.standardMapping = "none";
        expect(productOptionMatrixSchema.safeParse(noMappings).success).toBe(true);
    });

    it("requires paired barcode metadata and discount-type-specific values", () => {
        const barcodeTypeMissing = structuredClone(validMatrix);
        barcodeTypeMissing.variants[0]!.barcode = "123";
        expect(productOptionMatrixSchema.safeParse(barcodeTypeMissing).success).toBe(false);

        const mixedDiscount = structuredClone(validMatrix);
        mixedDiscount.variants[0]!.discountAmount = 10;
        expect(productOptionMatrixSchema.safeParse(mixedDiscount).success).toBe(false);

        const excessiveFlatDiscount = structuredClone(validMatrix);
        excessiveFlatDiscount.variants[0]!.discountType = "flat";
        excessiveFlatDiscount.variants[0]!.discountPercentage = null;
        excessiveFlatDiscount.variants[0]!.discountAmount = 101;
        expect(productOptionMatrixSchema.safeParse(excessiveFlatDiscount).success).toBe(false);
    });

    it("rejects image IDs not owned by the product", () => {
        const ownedImages = new Set(["img_primary", "img_detail"]);
        expect(() => assertVariantImageOwnership(null, ownedImages)).not.toThrow();
        expect(() => assertVariantImageOwnership("img_primary", ownedImages)).not.toThrow();
        expect(() => assertVariantImageOwnership("img_other_product", ownedImages))
            .toThrow(ValidationError);
    });

    it("preserves tracked simple-SKU stock during option conversion", () => {
        const simpleSku = [{
            isDefault: true,
            stock: 12,
            reservedStock: 0,
            preorderStock: 0,
            trackInventory: true,
        }];

        expect(() => assertOptionMatrixStockAllocation(simpleSku, [
            { stock: 7, trackInventory: true },
            { stock: 5, trackInventory: true },
        ])).not.toThrow();
        expect(() => assertOptionMatrixStockAllocation(simpleSku, [
            { stock: 7, trackInventory: true },
            { stock: 4, trackInventory: true },
        ])).toThrow(ValidationError);

        expect(() => assertOptionMatrixStockAllocation([
            { ...simpleSku[0]!, reservedStock: 1 },
        ], [{ stock: 12, trackInventory: true }])).toThrow(ConflictError);
    });

    it("preserves tracked stock when an axis edit replaces combinations", () => {
        const retiring = [
            { stock: 8, trackInventory: true },
            { stock: 4, trackInventory: true },
        ];
        expect(() => assertOptionMatrixReplacementStockAllocation(retiring, [
            { stock: 3, trackInventory: true },
            { stock: 9, trackInventory: true },
        ])).not.toThrow();
        expect(() => assertOptionMatrixReplacementStockAllocation(retiring, [
            { stock: 8, trackInventory: true },
            { stock: 8, trackInventory: true },
        ])).toThrow(ValidationError);

        expect(() => assertOptionMatrixReplacementStockAllocation(retiring, []))
            .not.toThrow();
    });

    it("enforces the five-axis and 150-combination release limits", () => {
        expect(MAX_PRODUCT_OPTION_AXES).toBe(5);
        expect(MAX_PRODUCT_OPTION_COMBINATIONS).toBe(150);

        const tooManyAxes = structuredClone(validMatrix);
        tooManyAxes.options = Array.from({ length: MAX_PRODUCT_OPTION_AXES + 1 }, (_, index) => ({
            id: `draft_axis_${index}`,
            name: `Axis ${index}`,
            standardMapping: "none" as const,
            values: [{ id: `draft_value_${index}`, value: `Value ${index}` }],
        }));
        tooManyAxes.variants = [row("draft_only", tooManyAxes.options.map((option) => option.values[0]!.id))];
        expect(productOptionMatrixSchema.safeParse(tooManyAxes).success).toBe(false);
    });

    it("surfaces the first matrix issue as a domain validation error", () => {
        expect(() => parseProductOptionMatrix({})).toThrow(ValidationError);
    });
});
