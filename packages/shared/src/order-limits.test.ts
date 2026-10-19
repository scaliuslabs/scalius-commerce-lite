import { describe, expect, it } from "vitest";
import { MAX_MINOR_AMOUNT } from "./money";
import { isLineAmountInRange, MAX_LINE_QUANTITY, MAX_ORDER_LINES } from "./order-limits";

describe("the order line limits", () => {
  it("keeps 99 lines and lets a line hold a wholesale quantity", () => {
    expect(MAX_ORDER_LINES).toBe(99);
    expect(MAX_LINE_QUANTITY).toBe(1_000_000);
  });

  it("refuses a line whose amount money cannot compute exactly", () => {
    expect(isLineAmountInRange(150_000, 120)).toBe(true);
    expect(isLineAmountInRange(MAX_MINOR_AMOUNT, 1)).toBe(true);
    expect(isLineAmountInRange(MAX_MINOR_AMOUNT, 2)).toBe(false);
    // 99,999,999.99 taka × a million units is beyond a safe integer of paisa.
    expect(isLineAmountInRange(9_999_999_999, MAX_LINE_QUANTITY)).toBe(false);
  });
});
