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
});
