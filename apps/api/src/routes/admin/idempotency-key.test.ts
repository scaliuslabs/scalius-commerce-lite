import { describe, expect, it } from "vitest";
import { resolveCanonicalIdempotencyKey } from "./idempotency-key";

describe("canonical admin idempotency key", () => {
    it("accepts either key source and one equal pair", () => {
        expect(resolveCanonicalIdempotencyKey("key-12345678", undefined, "commandKey"))
            .toBe("key-12345678");
        expect(resolveCanonicalIdempotencyKey(undefined, "key-12345678", "commandKey"))
            .toBe("key-12345678");
        expect(resolveCanonicalIdempotencyKey("key-12345678", "key-12345678", "commandKey"))
            .toBe("key-12345678");
    });

    it("rejects absence and exact mismatch", () => {
        expect(() => resolveCanonicalIdempotencyKey(undefined, undefined, "commandKey"))
            .toThrow("Idempotency-Key header or body.commandKey is required.");
        expect(() => resolveCanonicalIdempotencyKey("key-12345678", "key-87654321", "commandKey"))
            .toThrow("Idempotency-Key header must match body.commandKey.");
    });
});
