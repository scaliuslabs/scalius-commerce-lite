import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { storefrontSourcePath } from "../lib/test-source-paths";
import { getBuyerVariantPricePresentation } from "./product/lib/pricing-engine";
import { filterVariantsBySelection } from "./product/lib/variant-state-machine";

const COMPONENT_DIR = storefrontSourcePath("components");

describe("product shortcode purchase boundaries", () => {
  it("uses buyer-visible variants and disables purchase actions for unavailable products", () => {
    const source = readFileSync(`${COMPONENT_DIR}/ProductShortcode.tsx`, "utf8");

    expect(source).toContain("resolveBuyerVariants");
    expect(source).toContain("const buyerVariants = useMemo(");
    expect(source).toContain("const isUnavailable = buyerVariants.length === 0;");
    expect(source).toContain("This product is not available right now.");
    expect(source.match(/disabled=\{isUnavailable\}/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("uses merchant-defined option labels for cart context and visible selectors", () => {
    const source = readFileSync(`${COMPONENT_DIR}/ProductShortcode.tsx`, "utf8");

    expect(source).toContain("product.variantOption1Label");
    expect(source).toContain("product.variantOption2Label");
    expect(source).toContain("type CartItemOption");
    expect(source).toContain("name: option1Label");
    expect(source).toContain("name: option2Label");
    expect(source).not.toContain("(size/weight)");
    expect(source).not.toContain("(color/style)");
  });

  it("uses configured currency precision for arithmetic and display", () => {
    const source = readFileSync(`${COMPONENT_DIR}/ProductShortcode.tsx`, "utf8");

    expect(source).toContain("window.__CURRENCY_DECIMAL_PLACES__");
    expect(source).toContain("configuredDecimalPlaces,");
    expect(source).toContain("formatBuyerPrice(finalPrice)");
    expect(source).toContain("formatBuyerPrice(originalPrice)");
    expect(source).not.toContain("finalPrice.toLocaleString()");
  });

  it("shows the lowest compatible buyer SKU as From until selection is exact", () => {
    const source = readFileSync(`${COMPONENT_DIR}/ProductShortcode.tsx`, "utf8");
    const productPricing = {
      basePrice: 50_000,
      discountType: null,
      discountPercentage: null,
      discountAmount: null,
      currencyDecimalPlaces: 2,
    };
    const variants = [
      {
        size: "40",
        color: "Red",
        price: 45_000,
        discountType: null,
        discountPercentage: null,
        discountAmount: null,
        stock: 4,
        reservedStock: 0,
        trackInventory: true,
      },
      {
        size: "40",
        color: "Blue",
        price: 1_000,
        discountType: null,
        discountPercentage: null,
        discountAmount: null,
        stock: 0,
        reservedStock: 0,
        trackInventory: true,
      },
      {
        size: "42",
        color: "Green",
        price: 4_500,
        discountType: null,
        discountPercentage: null,
        discountAmount: null,
        stock: 3,
        reservedStock: 0,
        trackInventory: true,
      },
    ];
    const compatible = filterVariantsBySelection(variants, {
      selectedSize: "40",
    });

    expect(
      getBuyerVariantPricePresentation(productPricing, compatible).pricing
        .finalPrice,
    ).toBe(45_000);
    expect(source).toContain("filterVariantsBySelection(buyerVariants");
    expect(source).toContain("getBuyerVariantPricePresentation(");
    expect(source).toContain("showsStartingPrice ? \"From \" : \"\"");
    expect(source).toContain(
      "matchingVariant && pricePresentation.pricing.hasDiscount",
    );
  });
});
