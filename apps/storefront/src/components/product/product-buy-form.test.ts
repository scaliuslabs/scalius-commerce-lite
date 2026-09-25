// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression: without JavaScript a product without buyer inputs could not be
// bought. "Add to cart" and "Buy now" were type="button" with no form (only
// buyer-input products rendered the /buy/<slug> form), and the option buttons
// that choose a SKU only work with JavaScript.
const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const summary = read("./ProductSummary.astro");
const controller = read("./scripts/product-controller.ts");

describe("product buy form", () => {
  it("always renders a /buy/<slug> POST form", () => {
    expect(summary).toContain('const buyFormId = "product-buy-form";');
    expect(summary).toMatch(
      /<form id=\{buyFormId\} method="post" action=\{`\/buy\/\$\{encodeURIComponent\(product\.slug\)\}`\} data-product-buy-form>\s*<input type="hidden" name="variant"/,
    );
  });

  it("submits it from both buttons and the quantity field", () => {
    expect(summary).toContain('<button type="submit" form={buyFormId} data-action="add-to-cart"');
    expect(summary).toContain('<button type="submit" form={buyFormId} data-action="buy-now"');
    expect(summary).toMatch(/id="quantity" name="quantity" value="1" form=\{buyFormId\}/);
    expect(summary).not.toMatch(/type=\{buyFormId \?/);
  });

  it("lets a buyer without JavaScript choose the SKU in the same form", () => {
    expect(summary).toMatch(
      /<noscript>\s*<style is:inline>\.variant-option-selector\{display:none\}<\/style>[\s\S]*<select id="product-variant-noscript" name="variant" form=\{buyFormId\}/,
    );
  });

  it("keeps the script in charge once it runs (no navigation on Enter)", () => {
    expect(controller).toMatch(
      /const buyForm =\s*state\.buyerInputs\?\.form \?\?\s*document\.querySelector<HTMLFormElement>\("form\[data-product-buy-form\]"\);\s*buyForm\?\.addEventListener\("submit", \(event\) => \{\s*event\.preventDefault\(\);/,
    );
  });

describe("product page metadata price", () => {
  // Regression: og:price and the Product offer used the cheapest SKU while the
  // buy box opened on another one at a different price.
  it("reads the buy box's own opening choice", () => {
    const page = read("../../pages/products/[slug].astro");
    expect(page).toMatch(/const buyerPricingVariants = initialVariantPresentation\(/);
    expect(summary).toMatch(/\} = initialVariantPresentation\(options, variants, initialVariant, initialUnavailableVariant\);/);
  });
});

describe("quantity tiers beside the price", () => {
  it("are listed right after the price", () => {
    expect(summary).toMatch(/<ul class="mt-2 flex flex-wrap gap-1\.5" data-product-bundles aria-label=\{bundleListLabel\}>[\s\S]*<\/ul>\s*\) : null\}\s*<slot name="after-price" \/>/);
    expect(summary).toContain("const bundleTiers = describeBundleTiers(product.bundles ?? [], pageCopy, formatPrice);");
  });
});
});
