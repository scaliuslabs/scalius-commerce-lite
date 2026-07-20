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
const shippingSelectorSource = readFileSync(
  resolve(storefrontRoot, "src/components/ShippingLocationSelector.tsx"),
  "utf8",
);
const locationSelectorSource = readFileSync(
  resolve(storefrontRoot, "src/components/LocationSelector.tsx"),
  "utf8",
);
const dropdownSource = readFileSync(
  resolve(storefrontRoot, "src/components/CustomDropdown.tsx"),
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

  it("presents the same effective shipping fee in method cards and checkout calculations", () => {
    expect(source).toContain(
      "getEffectiveCartShippingFee(items, selectedMethodFee)",
    );
    expect(source).toContain("getEffectiveCartShippingFee(\n      items,");
    expect(shippingSelectorSource).toContain(
      "getEffectiveCartShippingFee(\n            visibleCartItems,",
    );
    expect(shippingSelectorSource).toContain(
      "clientReady ? storedCart.items : {}",
    );
    expect(shippingSelectorSource).toMatch(
      /const feeLabel\s*=\s*effectiveFee === 0/,
    );
    expect(shippingSelectorSource).toContain("formatPriceShort(effectiveFee)");
    expect(shippingSelectorSource).not.toContain("toLocaleString()");
    expect(shippingSelectorSource).toContain("waived by an item in your cart");
  });

  it("keeps location controls touch-sized on narrow buyer viewports", () => {
    expect(dropdownSource).toContain("min-h-11 w-full");
    expect(dropdownSource).toContain("sm:min-h-9");
    expect(dropdownSource).toContain("h-11 w-full");
    expect(dropdownSource).toContain("min-h-11 cursor-pointer");
    expect(locationSelectorSource).not.toContain(
      'triggerClassName="bg-gray-50 border-gray-200 rounded-lg h-9"',
    );
  });
});
