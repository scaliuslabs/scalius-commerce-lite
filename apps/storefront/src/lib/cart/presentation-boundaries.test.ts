import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const storefrontRoot = process.cwd().endsWith("/apps/storefront")
  ? process.cwd()
  : resolve(process.cwd(), "apps/storefront");

const source = readFileSync(
  resolve(storefrontRoot, "src/lib/cart/client.ts"),
  "utf8",
);

describe("cart page presentation contract", () => {
  it("keeps quantity and removal controls accessible after dynamic rendering", () => {
    expect(source).toContain('aria-label="Decrease ${safeName} quantity"');
    expect(source).toContain('aria-label="Increase ${safeName} quantity"');
    expect(source).toContain('aria-label="Remove ${safeName} from cart"');
  });

  it("formats every cart amount with the configured ISO currency precision", () => {
    expect(source).toContain("formatPriceShort(totalAmount)");
    expect(source).toContain("formatPriceShort(shippingFee)");
    expect(source).toContain("formatPriceShort(item.price * item.quantity)");
    expect(source).toContain("formatPriceShort(item.price)");
    expect(source).not.toContain("toLocaleString()");
  });
});
