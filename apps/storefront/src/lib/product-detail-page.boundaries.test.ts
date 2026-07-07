import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { storefrontSourcePath } from "./test-source-paths";

const PRODUCT_PAGE_SOURCE = storefrontSourcePath("pages/products/[slug].astro");

describe("product detail page SKU boundaries", () => {
  it("uses product.hasVariants for customer option metadata instead of buyer SKU count", () => {
    const source = readFileSync(PRODUCT_PAGE_SOURCE, "utf8");

    expect(source).toContain("data-product-has-variants={product.hasVariants.toString()}");
    expect(source).not.toContain("data-product-has-variants={(buyerVariants.length > 0).toString()}");
  });

  it("emits ProductGroup JSON-LD only for optioned buyer variants when enabled", () => {
    const source = readFileSync(PRODUCT_PAGE_SOURCE, "utf8");

    expect(source).toContain("discoverySettings.structuredData.productGroups");
    expect(source).toContain('buyerVariantResolution.mode === "optioned"');
    expect(source).toContain('"@type": "ProductGroup"');
    expect(source).toContain("url: canonicalUrl");
    expect(source).toContain("hasVariant: buyerVariants.map");
    expect(source).toContain("url: buildVariantProductUrl(variant) ?? canonicalUrl");
    expect(source).toContain('url.searchParams.set("size", size)');
    expect(source).toContain('url.searchParams.set("color", color)');
    expect(source).toContain("isVariantAvailable(variant)");
    expect(source).toContain('"@type": "Product"');
    expect(source).toContain("mappedVariantSchemaProps(variant)");
    expect(source).toContain("shouldEmitProductGroupJsonLd");
  });

  it("uses catalog-discovery image validation for Product JSON-LD and social images", () => {
    const source = readFileSync(PRODUCT_PAGE_SOURCE, "utf8");

    expect(source).toContain("resolveCatalogDiscoveryImageUrl(primaryImageUrl, storefrontUrl");
    expect(source).toContain("getOptimizedImageUrl(imageUrl");
    expect(source).toContain("image: [ogImageUrl]");
    expect(source).not.toContain("toAbsoluteStorefrontSeoUrl");
  });

  it("uses category canonical overrides in product BreadcrumbList JSON-LD", () => {
    const source = readFileSync(PRODUCT_PAGE_SOURCE, "utf8");

    expect(source).toContain("const productCategoryUrl = productCategory");
    expect(source).toContain("productCategory.canonicalPath");
    expect(source).toContain("item: productCategoryUrl");
    expect(source).not.toContain('item: `${storefrontUrl}/categories/${productCategory.slug}`');
  });

  it("keeps Product offer schema tied to active shipping methods and schema-safe GTINs", () => {
    const source = readFileSync(PRODUCT_PAGE_SOURCE, "utf8");

    expect(source).toContain("getShippingMethods()");
    expect(source).toContain("discoverySettings.structuredData.offerShippingDetails");
    expect(source).toContain("buildOfferShippingDetails({");
    expect(source).toContain("shippingMethods,");
    expect(source).toContain("freeDelivery: product.freeDelivery");
    expect(source).toContain("shippingDetails: offerShippingDetails");
    expect(source).toContain("buildMerchantReturnPolicyJsonLd({");
    expect(source).toContain("settings: layoutData.seo?.returnPolicy");
    expect(source).toContain("hasMerchantReturnPolicy: merchantReturnPolicyJsonLd");
    expect(source).toContain("gtinJsonLdForVariant(variant.barcode, variant.barcodeType)");
    expect(source).toContain("buyerVariants[0]?.barcode");
    expect(source).not.toContain("priceValidUntil");
    expect(source).toContain("normalizeSavedProductCondition(product.productCondition)");
    expect(source).toContain("PRODUCT_CONDITION_SCHEMA_URLS[productCondition]");
    expect(source).toContain("itemCondition: productConditionSchemaUrl");
    expect(source).not.toContain('itemCondition: "https://schema.org/NewCondition"');
    expect(source).toContain("sellerSchemaName");
    expect(source).toContain("layoutData.business?.companyName");
    expect(source).toContain("layoutData.business?.legalName");
    expect(source).not.toContain("layoutData?.footer?.copyrightText");
    expect(source).not.toContain("layoutData?.header?.logo?.alt");
    expect(source).not.toContain('||\n  "Store"');
    expect(source).toContain("const brandName = brandAttribute?.value?.trim() || null");
    expect(source).not.toContain("brandAttribute?.value || storeName");
  });
});
