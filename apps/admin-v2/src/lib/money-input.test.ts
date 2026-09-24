import { describe, expect, it } from "vitest";
import { parseAmountInput } from "./money-input";

describe("parseAmountInput", () => {
  it("accepts Bangla digits, lakh commas and up to two decimals", () => {
    expect(parseAmountInput("৬০")).toBe(60);
    expect(parseAmountInput(" 1,00,000 ")).toBe(100_000);
    expect(parseAmountInput("৬০.৫০")).toBe(60.5);
  });

  it("rejects anything that isn't a plain amount", () => {
    expect(parseAmountInput("")).toBeNull();
    expect(parseAmountInput("-5")).toBeNull();
    expect(parseAmountInput("60.555")).toBeNull();
    expect(parseAmountInput("৳60")).toBeNull();
    expect(parseAmountInput("1e5")).toBeNull();
  });
});
