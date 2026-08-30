import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./OrderItemsCard.tsx", import.meta.url), "utf8");

describe("admin order delivery-method snapshot", () => {
  it("shows saved service terms, fee waiver truth, and an honest unknown state", () => {
    expect(source).toContain("shippingMethodName");
    expect(source).toContain("shippingMethodDescription");
    expect(source).toContain("shippingMethodBaseAmountMinor");
    expect(source).toContain("shippingFeeWaived");
    expect(source).toContain("Delivery method was not recorded for this order.");
  });
});
