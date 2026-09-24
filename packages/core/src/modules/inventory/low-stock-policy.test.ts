import { describe, expect, it } from "vitest";
import { isLowStockThresholdEnabled } from "./low-stock-policy";

describe("low-stock policy", () => {
  it.each([
    [null, false],
    [undefined, false],
    [0, false],
    [-1, false],
    [Number.NaN, false],
    [5, true],
  ])("treats threshold %s enabled=%s", (threshold, expected) => {
    expect(isLowStockThresholdEnabled(threshold)).toBe(expected);
  });
});
