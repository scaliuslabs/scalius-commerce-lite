import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./invoice-order-reader.ts", import.meta.url)),
  "utf8",
);

describe("invoice order projection", () => {
  it("uses immutable order-item labels without joining the live catalog", () => {
    expect(source).toContain("productName: orderItems.productName");
    expect(source).toContain("variantLabel: orderItems.variantLabel");
    expect(source).not.toContain(".leftJoin(products");
    expect(source).not.toContain("productVariants");
  });

  it("reads only order and item invoice facts", () => {
    expect(source).toContain("shippingMethodId: orders.shippingMethodId");
    expect(source).toContain("shippingMethodName: orders.shippingMethodName");
    expect(source).toContain("shippingMethodDescription: orders.shippingMethodDescription");
    expect(source).toContain("shippingMethodBaseAmountMinor: orders.shippingMethodBaseAmountMinor");
    expect(source).toContain("shippingFeeWaived: orders.shippingFeeWaived");
    expect(source).not.toContain("deliveryShipments");
    expect(source).not.toContain("refundAttempt");
    expect(source).not.toContain("supportRequest");
  });
});
