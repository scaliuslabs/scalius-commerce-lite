import { describe, expect, it } from "vitest";
import { ValidationError } from "@scalius/core/errors";
import {
    getOrderedVariantImageOptionValues,
    normalizeVariantImageOptionValue,
    prepareVariantImageMappingsForWrite,
} from "./products.variant-images";

const variants = [
    {
        id: "var_large",
        size: "Large",
        color: "Red",
        sizeSortOrder: 2,
        colorSortOrder: 0,
        isDefault: false,
        createdAt: 2,
    },
    {
        id: "var_small",
        size: "Small",
        color: "Blue",
        sizeSortOrder: 1,
        colorSortOrder: 1,
        isDefault: false,
        createdAt: 1,
    },
];
describe("product variant image associations", () => {
    it("orders and normalizes only explicit merchant option values", () => {
        expect(getOrderedVariantImageOptionValues(variants, "option1")).toEqual([
            "Small",
            "Large",
        ]);
        expect(normalizeVariantImageOptionValue("  ReD  ")).toBe("red");
    });

    it("validates image, SKU, axis, and option ownership before writes", () => {
        const common = {
            productId: "prod_1",
            enabled: true,
            axis: "option1" as const,
            imageIdMap: new Map([["client_1", "img_1"]]),
            variants,
            createId: () => "mapping_1",
        };
        expect(prepareVariantImageMappingsForWrite({
            ...common,
            mappings: [{
                imageId: "client_1",
                optionAxis: "option1",
                optionValue: " small ",
            }],
        })).toMatchObject([{
            imageId: "img_1",
            optionAxis: "option1",
            optionValue: "Small",
            normalizedOptionValue: "small",
        }]);

        expect(() => prepareVariantImageMappingsForWrite({
            ...common,
            mappings: [{ imageId: "missing", optionAxis: "option1", optionValue: "Small" }],
        })).toThrow(ValidationError);
        expect(() => prepareVariantImageMappingsForWrite({
            ...common,
            mappings: [{ imageId: "client_1", optionAxis: "option2", optionValue: "Red" }],
        })).toThrow(ValidationError);
        expect(() => prepareVariantImageMappingsForWrite({
            ...common,
            mappings: [{ imageId: "client_1", variantId: "missing" }],
        })).toThrow(ValidationError);
    });
});
