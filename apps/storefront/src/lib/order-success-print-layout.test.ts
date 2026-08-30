import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { storefrontSourcePath } from "./test-source-paths";

describe("order-success print layout", () => {
  it("uses a compact A4 receipt grid without truncating order items", () => {
    const page = readFileSync(storefrontSourcePath("pages", "order-success.astro"), "utf8");
    const styles = readFileSync(storefrontSourcePath("styles", "global.css"), "utf8");

    expect(page).toContain('data-order-success-print={order ? "receipt" : undefined}');
    expect(page).toContain("order-success-print-order");
    expect(page).toContain("order-success-print-shipping");
    expect(page).toContain("order-success-print-items");
    expect(page).toContain("order-success-print-item");
    expect(styles).toContain("size: A4 portrait");
    expect(styles).toContain("grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr)");
    expect(styles).toContain("break-inside: avoid");
    const receiptStyles = styles.slice(styles.indexOf('[data-order-success-print="receipt"]'));
    expect(receiptStyles).not.toContain("max-height:");
    expect(receiptStyles).not.toContain("overflow: hidden");
  });

  it("shows the immutable delivery-method snapshot on receipt and account order detail", () => {
    const receipt = readFileSync(storefrontSourcePath("pages", "order-success.astro"), "utf8");
    const accountOrder = readFileSync(
      storefrontSourcePath("pages", "account", "orders", "[id].astro"),
      "utf8",
    );

    for (const source of [receipt, accountOrder]) {
      expect(source).toContain("shippingMethodName");
      expect(source).toContain("shippingMethodDescription");
      expect(source).toContain("shippingMethodBaseAmountMinor");
      expect(source).toContain("shippingFeeWaived");
      expect(source).toContain("Delivery method was not recorded for this order.");
    }
  });
});
