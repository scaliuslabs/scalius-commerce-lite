import { describe, expect, it } from "vitest";
import { pairFromStored, storedFromPair } from "./compare-at";

describe("price and compare-at price over the stored base price and discount", () => {
  it("reads a discounted product as its selling price over the original", () => {
    expect(pairFromStored(1000, 800)).toEqual({ price: 800, compareAt: 1000 });
    expect(pairFromStored(1000, null)).toEqual({ price: 1000, compareAt: null });
    expect(pairFromStored(null, null)).toEqual({ price: null, compareAt: null });
  });

  it("stores the compare-at price as the base and the difference as a flat discount", () => {
    expect(storedFromPair({ price: 800, compareAt: 1000 }, 2)).toEqual({ price: 1000, discounted: true, discountAmount: 200, problem: null });
    // Exact in minor units: no 0.30000000000000004.
    expect(storedFromPair({ price: 0.7, compareAt: 1 }, 2)).toEqual({ price: 1, discounted: true, discountAmount: 0.3, problem: null });
  });

  it("stores a single price as the base with no discount", () => {
    expect(storedFromPair({ price: 800, compareAt: null }, 2)).toEqual({ price: 800, discounted: false, discountAmount: 0, problem: null });
    expect(storedFromPair({ price: null, compareAt: null }, 2).price).toBeNull();
  });

  it("refuses a compare-at price that is not above the price, or not an amount", () => {
    expect(storedFromPair({ price: 800, compareAt: 800 }, 2)).toMatchObject({ price: 800, discounted: false, problem: "notHigher" });
    expect(storedFromPair({ price: 800, compareAt: 5 }, 2)).toMatchObject({ price: 800, discounted: false, problem: "notHigher" });
    expect(storedFromPair({ price: 800, compareAt: Number.NaN }, 2)).toMatchObject({ discounted: false, problem: "invalid" });
  });

  it("waits for the price before judging the compare-at price", () => {
    expect(storedFromPair({ price: null, compareAt: 1000 }, 2)).toMatchObject({ price: null, discounted: false, problem: null });
    expect(storedFromPair({ price: Number.NaN, compareAt: 1000 }, 2)).toMatchObject({ discounted: false, problem: null });
  });
});
