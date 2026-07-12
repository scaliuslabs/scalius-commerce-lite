import { describe, expect, it } from "vitest";
import { moveMediaSchema, updateMediaSchema } from "./media.validation";

describe("media command validation", () => {
    it("requires dimensions to be changed as one coherent pair", () => {
        expect(updateMediaSchema.safeParse({ expectedVersion: 1, width: 800 }).success).toBe(false);
        expect(updateMediaSchema.safeParse({ expectedVersion: 1, height: 600 }).success).toBe(false);
        expect(updateMediaSchema.safeParse({ expectedVersion: 1, width: null, height: 600 }).success).toBe(false);
        expect(updateMediaSchema.safeParse({ expectedVersion: 1, width: 800, height: 600 }).success).toBe(true);
        expect(updateMediaSchema.safeParse({ expectedVersion: 1, width: null, height: null }).success).toBe(true);
    });

    it("bounds bulk moves and requires unique per-item revisions", () => {
        const item = { id: "media_12345678", expectedVersion: 1 };
        expect(moveMediaSchema.safeParse({ items: [item], folderId: null }).success).toBe(true);
        expect(moveMediaSchema.safeParse({ items: [item, item], folderId: null }).success).toBe(false);
        expect(moveMediaSchema.safeParse({
            items: Array.from({ length: 91 }, (_, index) => ({
                id: `media_${String(index).padStart(8, "0")}`,
                expectedVersion: 1,
            })),
        }).success).toBe(false);
    });
});
