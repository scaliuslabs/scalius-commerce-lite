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
      /<noscript>\s*<style is:inline>\.variant-option-panels\{display:none\}<\/style>[\s\S]*<select id="product-variant-noscript" name="variant" form=\{buyFormId\}/,
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
    expect(page).toMatch(/const buyerInitialPresentation = initialVariantPresentation\(/);
    expect(page).toContain("const buyerPricingVariants = buyerInitialPresentation.pricingVariants;");
    // The gallery's first paint is the same opening choice's own photo.
    expect(page).toContain("featuredGalleryItem(galleryItems, initialVariantMediaId)");
    expect(summary).toMatch(/\} = initialVariantPresentation\(options, variants\);/);
  });
});

describe("quantity tiers beside the price", () => {
  it("are listed right after the price", () => {
    expect(summary).toMatch(/<ul class="mt-2 flex flex-wrap gap-1\.5" data-product-bundles aria-label=\{bundleListLabel\}>[\s\S]*<\/ul>\s*\) : null\}\s*<slot name="after-price" \/>/);
    expect(summary).toContain("const bundleTiers = describeBundleTiers(product.bundles ?? [], pageCopy, formatPrice);");
  });
});

describe("product page purchase aids", () => {
  const page = read("../../pages/products/[slug].astro");

  it("mounts the buy bars and anchor bars only from the product's resolved sticky choices", () => {
    expect(page).toContain("const sticky = resolvedTheme.blocks.product.sticky;");
    expect(page).toContain('phone={sticky.phoneBottom === "buy-bar"}');
    expect(page).toContain('desktop={sticky.desktop === "product-bar"}');
    // The bar's words and price are the page's own (the store's language), before any script.
    expect(page).toContain("{ label: productPageCopy.addToCartText, disabled: false }");
    expect(page).toContain("price={formatMoney(buyerDisplayedPrice, { code: currencyCode, symbol: currencySymbol })}");
    expect(page).toContain('phone={sticky.phoneTop === "anchor-bar"}');
    expect(page).toContain('desktop={sticky.desktop === "anchor-bar"}');
    expect(page).not.toMatch(/^\s*<StickyBuyBar productName=\{product\.name\} \/>/m);
  });

  it("shows the contact actions after purchase when the buy box asks for them, only from valid merchant phone links", () => {
    expect(page).toContain("const contactLinks = themeLayout.buyBox.whatsapp");
    expect(page).toContain('storeContactLinks(layoutData.business).filter((link) => link.kind !== "email")');
    // The buy box draws them (the core page and a product_main skin's buy form alike).
    expect(page).toContain("contactLinks,");
    const buyBox = read("./ProductBuyBox.astro");
    expect(buyBox).toMatch(/contactLinks\.length > 0 && \(\s*<nav slot="after-actions" data-product-contact/);
    expect(buyBox).toContain('data-product-contact-link={link.kind}');
    // Their words are the store's language (shop copy), never hard-coded English.
    expect(page).toContain("contactCopy: shop.product.contact,");
    expect(buyBox).not.toMatch(/"(Call|WhatsApp|Contact the store|Contact on WhatsApp)"/);
  });
});
});
