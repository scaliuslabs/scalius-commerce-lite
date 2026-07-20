import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const storefrontSrc = fileURLToPath(new URL("..", import.meta.url));

describe("order-success print layout", () => {
  it("uses a compact A4 receipt grid without truncating order items", () => {
    const page = readFileSync(`${storefrontSrc}/pages/order-success.astro`, "utf8");
    const styles = readFileSync(`${storefrontSrc}/styles/global.css`, "utf8");

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
});
