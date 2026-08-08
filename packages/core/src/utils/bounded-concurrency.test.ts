import { describe, expect, it } from "vitest";
import { mapWithBoundedConcurrency } from "./bounded-concurrency";

describe("mapWithBoundedConcurrency", () => {
    it("preserves order while limiting active work", async () => {
        let active = 0;
        let maximumActive = 0;
        const results = await mapWithBoundedConcurrency(
            Array.from({ length: 20 }, (_, index) => index),
            4,
            async (value) => {
                active += 1;
                maximumActive = Math.max(maximumActive, active);
                await Promise.resolve();
                active -= 1;
                return value * 2;
            },
        );

        expect(maximumActive).toBe(4);
        expect(results).toEqual(Array.from({ length: 20 }, (_, index) => index * 2));
    });
});
