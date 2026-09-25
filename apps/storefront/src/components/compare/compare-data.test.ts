import { describe, expect, it } from "vitest";
import { COMPARE_MAX, compareRowDiffers, parseCompareIds } from "./compare-data";

describe("compare ids", () => {
  it("keeps up to four distinct, well-formed ids in order", () => {
    expect(parseCompareIds("prod_a, prod_b,prod_a,,bad id,<x>,prod_c,prod_d,prod_e")).toEqual(["prod_a", "prod_b", "prod_c", "prod_d"]);
    expect(parseCompareIds("prod_a,prod_b,prod_c,prod_d,prod_e")).toHaveLength(COMPARE_MAX);
    expect(parseCompareIds(null)).toEqual([]);
    expect(parseCompareIds("x".repeat(81))).toEqual([]);
  });
});

describe("compare rows", () => {
  it("highlights a row whose values differ, an empty cell included", () => {
    expect(compareRowDiffers(["8GB", "8gb "])).toBe(false);
    expect(compareRowDiffers(["8GB", "16GB"])).toBe(true);
    expect(compareRowDiffers(["8GB", null])).toBe(true);
    expect(compareRowDiffers([null, null])).toBe(false);
  });
});
