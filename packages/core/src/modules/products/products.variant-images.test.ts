import { describe, expect, it } from "vitest";
import { ValidationError } from "@scalius/core/errors";
import {
    cleanVariantImageMetaDescription,
    prepareVariantImageMappingsForWrite,
    readLegacyVariantImageSettings,
    resolveVariantImageReadModel,
    synthesizeLegacyVariantImageMappings,
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
const images = [
    { id: "img_second", sortOrder: 1, createdAt: 2 },
    { id: "img_first", sortOrder: 0, createdAt: 1 },
];

describe("product variant image associations", () => {
    it("reads every legacy marker form and removes markers from SEO text", () => {
        expect(readLegacyVariantImageSettings("SEO<!--variant_images:enabled-->"))
            .toEqual({ enabled: true, axis: "option2" });
        expect(readLegacyVariantImageSettings("<!--variant_images:option2-->"))
            .toEqual({ enabled: true, axis: "option2" });
        expect(readLegacyVariantImageSettings(
            "<!--variant_images:enabled--><!--variant_images:option1-->",
        )).toEqual({ enabled: true, axis: "option1" });
        expect(cleanVariantImageMetaDescription(
            " Useful SEO <!--variant_images:option1-->",
        )).toBe("Useful SEO");
    });

    it("materializes the legacy positional map once using stable image IDs", () => {
        expect(synthesizeLegacyVariantImageMappings({
            productId: "prod_1",
            axis: "option1",
            images,
            variants,
        })).toMatchObject([
            { imageId: "img_first", optionValue: "Small", sortOrder: 0 },
            { imageId: "img_second", optionValue: "Large", sortOrder: 1 },
        ]);
    });

    it("prefers persisted associations over a conflicting retained marker", () => {
        const stored = [{
            id: "mapping_1",
            productId: "prod_1",
            imageId: "img_second",
            variantId: null,
            optionAxis: "option2" as const,
            optionValue: "Red",
            normalizedOptionValue: "red",
            sortOrder: 0,
        }];
        const result = resolveVariantImageReadModel({
            productId: "prod_1",
            variantImagesEnabled: true,
            variantImageAxis: "option2",
            metaDescription: "SEO<!--variant_images:option1-->",
            storedMappings: stored,
            images,
            variants,
        });

        expect(result.axis).toBe("option2");
        expect(result.mappings).toEqual(stored);
        expect(result.metaDescription).toBe("SEO");
    });

    it("keeps explicit enabled-with-no-mappings empty instead of reviving positions", () => {
        const result = resolveVariantImageReadModel({
            productId: "prod_1",
            variantImagesEnabled: true,
            variantImageAxis: "option1",
            metaDescription: null,
            storedMappings: [],
            images,
            variants,
        });
        expect(result.enabled).toBe(true);
        expect(result.mappings).toEqual([]);
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
