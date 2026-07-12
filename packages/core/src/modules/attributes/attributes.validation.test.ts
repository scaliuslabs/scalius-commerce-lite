import { describe, expect, it } from "vitest";
import {
    addValueSchema,
    bulkActionSchema,
    createAttributeSchema,
    deleteValueSchema,
    updateValueSchema,
} from "./attributes.validation";

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

    it("canonicalizes and bounds every value mutation", () => {
        expect(addValueSchema.parse({ value: "  Cotton  " })).toEqual({ value: "Cotton" });
        expect(updateValueSchema.parse({ oldValue: "Cotton", newValue: "  Linen " }))
            .toEqual({ oldValue: "Cotton", newValue: "Linen" });

        for (const schema of [
            addValueSchema.safeParse({ value: "x".repeat(101) }),
            updateValueSchema.safeParse({ oldValue: "Cotton", newValue: "x".repeat(101) }),
            deleteValueSchema.safeParse({ value: "x".repeat(101) }),
        ]) {
            expect(schema.success).toBe(false);
        }
    });

    it("trims and bounds definition slugs", () => {
        expect(createAttributeSchema.parse({
            name: "Material",
            slug: "  material  ",
        }).slug).toBe("material");
        expect(createAttributeSchema.safeParse({
            name: "Material",
            slug: "m".repeat(101),
        }).success).toBe(false);
    });
});
