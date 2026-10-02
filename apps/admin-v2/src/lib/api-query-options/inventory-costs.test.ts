import { describe, expect, it } from "vitest";
import { costMargin, costProblem, sameCost, UNIT_COST_MAX } from "./inventory-costs";

describe("costMargin", () => {
  it("is the profit of what the customer pays and its share of that price, to one decimal", () => {
    expect(costMargin(1200, 780, 2)).toEqual({ profit: 420, margin: 35 });
    // 1/3 of the price: 33.333…% rounds to 33.3%.
    expect(costMargin(300, 200, 2)).toEqual({ profit: 100, margin: 33.3 });
  });

  it("keeps paisa exactly (a cost is not a cash amount)", () => {
    expect(costMargin(100, 12.35, 2)).toEqual({ profit: 87.65, margin: 87.7 });
    expect(costMargin(0.3, 0.1, 2)).toEqual({ profit: 0.2, margin: 66.7 });
  });

  it("uses the discounted price when the caller passes what the customer pays", () => {
    // ৳1,000 with 20% off sells for ৳800.
    expect(costMargin(800, 600, 2)).toEqual({ profit: 200, margin: 25 });
  });

  it("shows a loss when the cost is above the price", () => {
    expect(costMargin(500, 650, 2)).toEqual({ profit: -150, margin: -30 });
  });

  it("has no figures without a cost or a usable price", () => {
    expect(costMargin(500, null, 2)).toBeNull();
    expect(costMargin(500, undefined, 2)).toBeNull();
    expect(costMargin(null, 100, 2)).toBeNull();
    expect(costMargin(Number.NaN, 100, 2)).toBeNull();
    expect(costMargin(500, Number.NaN, 2)).toBeNull();
    expect(costMargin(500, -1, 2)).toBeNull();
  });

  it("has a profit but no margin at a price of zero", () => {
    expect(costMargin(0, 40, 2)).toEqual({ profit: -40, margin: null });
  });

  it("never reads -0%", () => {
    // A paisa below the price: -0.0001% rounds to zero, which must be +0.
    const result = costMargin(100_000, 100_000.01, 2);
    expect(result?.profit).toBe(-0.01);
    expect(Object.is(result?.margin, 0)).toBe(true);
  });
});

describe("costProblem", () => {
  it("accepts empty (no cost), zero and paisa", () => {
    expect(costProblem(null)).toBeNull();
    expect(costProblem(0)).toBeNull();
    expect(costProblem(12.5)).toBeNull();
  });

  it("names what can't be saved", () => {
    expect(costProblem(-1)).toBe("costInvalid");
    expect(costProblem(Number.NaN)).toBe("costInvalid");
    expect(costProblem(UNIT_COST_MAX + 1)).toBe("costTooLarge");
  });
});

describe("sameCost", () => {
  it("treats a missing cost as no cost", () => {
    expect(sameCost(undefined, null)).toBe(true);
    expect(sameCost(0, null)).toBe(false);
    expect(sameCost(12.5, 12.5)).toBe(true);
  });
});
