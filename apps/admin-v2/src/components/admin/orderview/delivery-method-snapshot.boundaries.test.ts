import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./OrderItemsCard.tsx", import.meta.url), "utf8");
const presentationSource = readFileSync(
  new URL("../../../lib/delivery-method-presentation.ts", import.meta.url),
  "utf8",
);

describe("admin order delivery-method snapshot", () => {
  it("shows saved service terms, fee waiver truth, and an honest unknown state", () => {
    expect(source).toContain("resolveDeliveryMethodPresentation(order, savedSummary)");
    expect(presentationSource).toContain("shippingMethodName");
    expect(presentationSource).toContain("shippingMethodDescription");
    expect(presentationSource).toContain("shippingMethodBaseAmountMinor");
    expect(presentationSource).toContain("shippingFeeWaived");
    expect(source).toContain("Delivery method was not recorded for this order.");
  });
});
