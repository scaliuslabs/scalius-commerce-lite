import { describe, expect, it } from "vitest";

import {
  STOREFRONT_COMPUTER_ACCESSIBLE_NAME_MAX_CHARS,
  buildStorefrontComputerAddToCartLabel,
} from "./computer-add-to-cart";

describe("Storefront computer Add to Cart labels", () => {
  it("preserves bounded product, exact variant, and terminal action identity", () => {
    const variantId = `var_${"v".repeat(21)}`;
    const label = buildStorefrontComputerAddToCartLabel({
      productName: `Premium ${"P".repeat(92)}`,
      variantId,
      options: [
        { name: `Merchant ${"option ".repeat(20)}`, label: "A".repeat(180) },
        { name: "Style", label: "B".repeat(180) },
      ],
    });

    expect(label.length).toBeLessThanOrEqual(
      STOREFRONT_COMPUTER_ACCESSIBLE_NAME_MAX_CHARS,
    );
    expect(label).toMatch(/^Add Premium P/u);
    expect(label).toContain(`variant ${variantId}`);
    expect(label).toContain("…");
    expect(label).toMatch(/ to cart$/u);
  });
});
