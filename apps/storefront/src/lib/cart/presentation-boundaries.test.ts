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
const cartPageSource = readFileSync(
  resolve(storefrontRoot, "src/pages/cart.astro"),
  "utf8",
);

describe("cart page presentation contract", () => {
  it("keeps quantity and removal controls accessible after dynamic rendering", () => {
    expect(source).toContain('aria-label="Decrease ${safeName} quantity"');
    expect(source).toContain('aria-label="Increase ${safeName} quantity"');
    expect(source).toContain('aria-label="Remove ${safeName} from cart"');
    expect(source).toContain(
      'class="flex h-11 items-center overflow-hidden rounded-md ring-1',
    );
    expect(source).toContain(
      'class="flex h-full w-11 items-center justify-center text-sm',
    );
    expect(source).toContain(
      'class="ml-1.5 flex h-11 w-11 shrink-0 items-center justify-center',
    );
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
    expect(shippingSelectorSource).toContain("flex min-h-11 items-center");
  });

  it("does not compress primary checkout controls below the mobile target floor", () => {
    expect(cartPageSource).toContain(
      'className="h-11 w-full bg-muted border-input rounded-lg',
    );
    expect(cartPageSource).toContain(
      'className="h-11 w-full bg-primary text-primary-foreground',
    );
    expect(cartPageSource).toContain(
      'class="flex min-h-11 items-center rounded-md px-1',
    );
    expect(cartPageSource).toContain(
      'class="h-11 min-w-0 flex-1 rounded-lg border border-input',
    );
    expect(cartPageSource).toContain(
      'class="h-11 rounded-lg bg-primary px-4',
    );
    expect(cartPageSource).not.toContain("    .h-9 {\n      height: 2rem;");
    expect(cartPageSource).not.toContain("    .h-10 {\n      height: 2.25rem;");
  });
});
