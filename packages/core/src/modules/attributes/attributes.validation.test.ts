import { describe, expect, it } from "vitest";
import { bulkActionSchema, createAttributeSchema } from "./attributes.validation";

describe("attribute validation", () => {
    it("trims names and options and deduplicates option values case-insensitively", () => {
        const result = createAttributeSchema.parse({
            name: "  Material  ",
            slug: "material",
            filterable: true,
            options: [" Cotton ", "cotton", "Linen"],
        });

        expect(result.name).toBe("Material");
        expect(result.options).toEqual(["Cotton", "Linen"]);
    });

    it("rejects empty and excessively long option values", () => {
        expect(() => createAttributeSchema.parse({
            name: "Material",
            slug: "material",
            options: ["  "],
        })).toThrow();
        expect(() => createAttributeSchema.parse({
            name: "Material",
            slug: "material",
            options: ["x".repeat(101)],
        })).toThrow();
    });

    it("caps bulk actions below D1's bound-parameter ceiling", () => {
        expect(() => bulkActionSchema.parse({
            ids: Array.from({ length: 91 }, (_, index) => `attr_${index}`),
        })).toThrow();
    });
});
