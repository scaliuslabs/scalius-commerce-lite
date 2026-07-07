import { describe, expect, it } from "vitest";
import { updateCollectionSchema } from "./collections.validation";

describe("collection validation", () => {
    it("does not clear canonical path on unrelated partial updates", () => {
        const parsed = updateCollectionSchema.parse({ isActive: false });

        expect(parsed).toEqual({ isActive: false });
    });

    it("normalizes blank canonical path updates to null", () => {
        const parsed = updateCollectionSchema.parse({ canonicalPath: "   " });

        expect(parsed).toEqual({ canonicalPath: null });
    });

    it("accepts collection-shaped canonical overrides", () => {
        const parsed = updateCollectionSchema.parse({
            canonicalPath: " /collections/col_1 ",
        });

        expect(parsed).toEqual({ canonicalPath: "/collections/col_1" });
    });

    it("rejects canonical overrides that are not collection routes", () => {
        for (const canonicalPath of [
            "/featured/summer",
            "/collections/summer/edit",
            "/collections/summer-edit",
            "/categories/summer-edit",
        ]) {
            expect(
                updateCollectionSchema.safeParse({ canonicalPath }).success,
                canonicalPath,
            ).toBe(false);
        }
    });
});
