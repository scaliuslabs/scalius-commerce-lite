import { describe, expect, it } from "vitest";
import { chunkRowsForD1 } from "./d1-write-chunks";

describe("D1 multi-row insert chunking", () => {
    it("keeps every statement below the 100-parameter ceiling", () => {
        const rows = Array.from({ length: 99 }, (_, index) => index);

        for (const parametersPerRow of [13, 18]) {
            const chunks = chunkRowsForD1(rows, parametersPerRow);
            expect(chunks.flat()).toEqual(rows);
            expect(Math.max(...chunks.map((chunk) => chunk.length * parametersPerRow)))
                .toBeLessThan(100);
        }
    });

    it("rejects an invalid parameter estimate", () => {
        expect(() => chunkRowsForD1([1], 0)).toThrow(RangeError);
    });
});
