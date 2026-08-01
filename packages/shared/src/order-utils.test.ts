import { describe, expect, it } from "vitest";

import { generateOrderId, ORDER_ID_LENGTH } from "./order-utils";

describe("generateOrderId", () => {
  it("generates readable 80-bit identifiers", () => {
    const ids = Array.from({ length: 10_000 }, generateOrderId);

    expect(ids.every((id) => id.length === ORDER_ID_LENGTH)).toBe(true);
    expect(
      ids.every((id) => /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{16}$/.test(id)),
    ).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
