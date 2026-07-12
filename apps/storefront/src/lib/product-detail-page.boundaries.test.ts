import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { storefrontSourcePath } from "./test-source-paths";
import {
  calculateVariantPrice,
  formatPrice,
  getBuyerVariantPricePresentation,
} from "@/components/product/lib/pricing-engine";

const PRODUCT_PAGE_SOURCE = storefrontSourcePath("pages/products/[slug].astro");
const PRODUCT_SUMMARY_SOURCE = storefrontSourcePath(
  "components/product/ProductSummary.astro",
);

describe("product detail page SKU boundaries", () => {
  it("preserves fractional buyer prices at configured currency precision", () => {
    const kwd = calculateVariantPrice(
      {
        basePrice: 1.234,
        discountType: "percentage",
        discountPercentage: 10,
        discountAmount: 0,
        currencyDecimalPlaces: 3,
      },
      {
        price: 1.234,
        discountType: null,
        discountPercentage: 0,
        discountAmount: 0,
      },
    );
    const bdt = calculateVariantPrice(
      {
        basePrice: 10.4,
        discountType: "flat",
        discountPercentage: 0,
        discountAmount: 10,
        currencyDecimalPlaces: 2,
      },
      null,
    );
    const checkoutRoundingBoundary = calculateVariantPrice(
      {
        basePrice: 1.005,
        discountType: "percentage",
        discountPercentage: 10,
        discountAmount: null,
        currencyDecimalPlaces: 2,
      },
      null,
    );
    const defaultBdtPrecision = calculateVariantPrice(
      {
        basePrice: 10.4,
        discountType: "flat",
        discountPercentage: null,
        discountAmount: 10,
      },
      null,
    );

    expect(kwd.finalPrice).toBe(1.111);
    expect(bdt.finalPrice).toBe(0.4);
    expect(checkoutRoundingBoundary).toMatchObject({
      originalPrice: 1.01,
      finalPrice: 0.9,
    });
    expect(defaultBdtPrecision.finalPrice).toBe(0.4);
    expect(formatPrice(kwd.finalPrice, "د.ك", 3)).toBe("د.ك1.111");
  });

  it("renders a truthful lowest-SKU starting price before option hydration", () => {
    const source = readFileSync(PRODUCT_SUMMARY_SOURCE, "utf8");
    const productPricing = {
      basePrice: 45_600,
      discountType: "percentage" as const,
      discountPercentage: 10,
      discountAmount: 0,
    };
    const variants = [
      {
        price: 45_600,
        discountType: null,
        discountPercentage: 0,
        discountAmount: 0,
        stock: 5,
        reservedStock: 0,
        trackInventory: true,
      },
      {
        price: 4_500,
        discountType: null,
        discountPercentage: 0,
        discountAmount: 0,
        stock: 5,
        reservedStock: 0,
        trackInventory: true,
      },
    ];
    const presentation = getBuyerVariantPricePresentation(
      productPricing,
      variants,
    );
    const availableOnlyPresentation = getBuyerVariantPricePresentation(
      productPricing,
      [variants[0]!, { ...variants[1]!, stock: 0 }],
    );
    const allSoldOutPresentation = getBuyerVariantPricePresentation(
      productPricing,
      variants.map((variant) => ({ ...variant, stock: 0 })),
    );

    expect(presentation).toMatchObject({
      isStartingAt: true,
      pricing: { finalPrice: 4_050 },
    });
    expect(availableOnlyPresentation.pricing.finalPrice).toBe(41_040);
    expect(allSoldOutPresentation.pricing.finalPrice).toBe(4_050);
    expect(source).toContain(
      "getBuyerVariantPricePresentation(productPricing, pricingVariants)",
    );
    expect(source).toContain("const showsStartingPrice = shouldShowStartingVariantPrice(");
    expect(source).toContain("const stockVariant = initialUnavailableVariant ?? initialSelectedVariant;");
    expect(source).toContain(
      '{showsStartingPrice ? "From " : ""}{formatPrice(pricePresentation.pricing.finalPrice)}',
    );
    expect(source).toContain("{ hidden: !exactPricing?.hasDiscount }");
    expect(source).toContain("{ hidden: !discountBadge }");
  });

  it("uses the shared buyer price for product metadata and initial analytics", () => {
    const source = readFileSync(PRODUCT_PAGE_SOURCE, "utf8");

    expect(source).toContain(
      "const buyerPricePresentation = getBuyerVariantPricePresentation(",
    );
    expect(source).toContain(
      "const buyerDisplayedPrice = buyerPricePresentation.pricing.finalPrice;",
    );
    expect(source).toContain("price: formatMetadataPrice(buyerDisplayedPrice)");
    expect(source).toContain(
      "ogPrice={formatMetadataPrice(buyerDisplayedPrice)}",
    );
    expect(source).toContain(
      "data-product-price={String(buyerDisplayedPrice)}",
    );
    expect(source).toContain("discountedPrice: buyerDisplayedPrice");
    expect(source).toContain(
      "data-currency-decimal-places={String(currencyDecimalPlaces)}",
    );
    expect(source).not.toContain("price: buyerDisplayedPrice.toFixed(2)");
    expect(source).not.toContain(
      "ogPrice={product.discountedPrice.toFixed(2)}",
    );
    expect(source).not.toContain(
      "data-product-price={String(product.discountedPrice)}",
    );
  });

  it("resolves exact variant query state for SSR metadata and analytics", () => {
    const source = readFileSync(PRODUCT_PAGE_SOURCE, "utf8");

    expect(source).toContain(
      "const requestedQueryVariantSelection = resolveExactVariantSelection(buyerVariants",
    );
    expect(source).toContain(
      'variantId: Astro.url.searchParams.get("variant")',
    );
    expect(source).toContain(
      "isVariantAvailable(requestedQueryVariantSelection.variant)",
    );
    expect(source).toContain("const unavailableQueryVariantSelection =");
    expect(source).toContain(
      "const selectedBuyerVariant = requestedQueryVariantSelection?.variant ?? null;",
    );
    expect(source).toContain("const fbViewVariants = selectedBuyerVariant");
    expect(source).toContain(
      "const primarySchemaVariant = selectedBuyerVariant",
    );
    expect(source).toContain("initialVariant={queryVariantSelection?.variant}");
    expect(source).toContain(
      "initialUnavailableVariant={unavailableQueryVariantSelection?.variant}",
    );
    expect(source).not.toContain('Astro.url.searchParams.get("size")');
    expect(source).not.toContain('Astro.url.searchParams.get("color")');
  });

  it("SSR-classifies accessible option toggles without disabling compatible switches", () => {
    const source = readFileSync(PRODUCT_SUMMARY_SOURCE, "utf8");

    expect(source).toContain("getVariantOptionAvailabilityMap(");
    expect(source).toContain('type="button"');
    expect(source).toContain('aria-pressed={selected ? "true" : "false"}');
    expect(source).toContain("data-option-availability={status}");
    expect(source).toContain('disabled={status === "sold_out"}');
    expect(source).toContain('status === "incompatible"');
    expect(source).toContain(
      "border-dashed border-muted-foreground bg-muted text-foreground",
    );
    expect(source).not.toContain(
      "bg-muted/50 text-muted-foreground border-dashed border-muted-foreground/40 opacity-50",
    );
    expect(source).toContain("cursor-not-allowed border-input bg-background text-foreground opacity-50 line-through");
    expect(source).toContain('id="variant-availability-status"');
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain("Selected; activate again to clear.");
    expect(source).toContain("options.map((option) =>");
    expect(source).toContain("option.values.map((value) =>");
    expect(source).toContain('id="product-stock-badge"');
    expect(source).toContain('id="variant-unavailable-query-notice"');
    expect(source).toContain('data-action-label="add-to-cart"');
    expect(source).toContain(
      "initialUnavailableVariant ?? initialSelectedVariant",
    );
    expect(source).toContain("const pricingVariants = initialSelectedVariant");
    expect(source).toContain("shouldShowStartingVariantPrice(");
    expect(source).toContain("stockVariant ? [stockVariant] : variants");
    expect(source).not.toContain("globalSizeAvailability");
    expect(source).not.toContain('type="radio"');
  });

  it("uses product.hasVariants for customer option metadata instead of buyer SKU count", () => {
    const source = readFileSync(PRODUCT_PAGE_SOURCE, "utf8");

    expect(source).toContain(
      "data-product-has-variants={product.hasVariants.toString()}",
    );
    expect(source).not.toContain(
      "data-product-has-variants={(buyerVariants.length > 0).toString()}",
    );
  });

  it("emits ProductGroup JSON-LD only for optioned buyer variants when enabled", () => {
    const source = readFileSync(PRODUCT_PAGE_SOURCE, "utf8");

    expect(source).toContain("discoverySettings.structuredData.productGroups");
    expect(source).toContain('buyerVariantResolution.mode === "optioned"');
    expect(source).toContain('"@type": "ProductGroup"');
    expect(source).toContain("url: canonicalUrl");
    expect(source).toContain("hasVariant: buyerVariants.map");
    expect(source).toContain(
      "url: buildVariantProductUrl(variant) ?? canonicalUrl",
    );
    expect(source).toContain('url.searchParams.set("variant", variant.id)');
    expect(source).toContain("isVariantAvailable(variant)");
    expect(source).toContain('"@type": "Product"');
    expect(source).toContain("mappedVariantSchemaProps(variant)");
    expect(source).toContain("shouldEmitProductGroupJsonLd");
    expect(source).toContain("!selectedBuyerVariant");
  });

  it("maps ProductGroup variant labels and schema from merchant-defined option axes", () => {
    const source = readFileSync(PRODUCT_PAGE_SOURCE, "utf8");

    expect(source).toContain("const productOptions = product.options ?? [];");
    expect(source).toContain("for (const option of variant.selectedOptions)");
    expect(source).toContain("const schema = option.standardMapping;");
    expect(source).toContain(
      'if (schema === "none" || props[schema]) continue;',
    );
    expect(source).toContain("props[schema] = option.value;");
    expect(source).toContain(
      "`${option.name}: ${option.value}`",
    );
    expect(source).toContain("PRODUCT_OPTION_SCHEMA_URLS[option.standardMapping]");
    expect(source).not.toContain("variantOption1Label");
    expect(source).not.toContain("variantOption2Label");
    expect(source).not.toContain("`${product.name} - Size:");
    expect(source).not.toContain("`${product.name} - Color:");
    expect(source).not.toContain("props.size =");
    expect(source).not.toContain("props.color =");
  });

  it("uses catalog-discovery image validation for Product JSON-LD and social images", () => {
    const source = readFileSync(PRODUCT_PAGE_SOURCE, "utf8");

    expect(source).toContain(
      "resolveCatalogDiscoveryImageUrl(candidate, storefrontUrl",
    );
    expect(source).toContain("getOptimizedImageUrl(imageUrl");
    expect(source).toContain("image: schemaImageUrls");
    expect(source).toContain("getVariantSchemaImages(variant)");
    expect(source).toContain('item.kind === "image" ? item.url : item.posterUrl');
    expect(source).not.toContain("toAbsoluteStorefrontSeoUrl");
  });

  it("uses category canonical overrides in product BreadcrumbList JSON-LD", () => {
    const source = readFileSync(PRODUCT_PAGE_SOURCE, "utf8");

    expect(source).toContain("const productCategoryUrl = productCategory");
    expect(source).toContain("productCategory.canonicalPath");
    expect(source).toContain("item: productCategoryUrl");
    expect(source).not.toContain(
      "item: `${storefrontUrl}/categories/${productCategory.slug}`",
    );
  });

  it("keeps Product offer schema tied to active shipping methods and schema-safe GTINs", () => {
    const source = readFileSync(PRODUCT_PAGE_SOURCE, "utf8");

    expect(source).toContain("getShippingMethods()");
    expect(source).toContain(
      "discoverySettings.structuredData.offerShippingDetails",
    );
    expect(source).toContain("buildOfferShippingDetails({");
    expect(source).toContain("shippingMethods,");
    expect(source).toContain("freeDelivery: product.freeDelivery");
    expect(source).toContain("shippingDetails: offerShippingDetails");
    expect(source).toContain("buildMerchantReturnPolicyJsonLd({");
    expect(source).toContain("settings: layoutData.seo?.returnPolicy");
    expect(source).toContain(
      "hasMerchantReturnPolicy: merchantReturnPolicyJsonLd",
    );
    expect(source).toContain(
      "gtinJsonLdForVariant(variant.barcode, variant.barcodeType)",
    );
    expect(source).toContain("primarySchemaVariant?.barcode");
    expect(source).not.toContain("priceValidUntil");
    expect(source).toContain(
      "normalizeSavedProductCondition(product.productCondition)",
    );
    expect(source).toContain("PRODUCT_CONDITION_SCHEMA_URLS[productCondition]");
    expect(source).toContain("itemCondition: productConditionSchemaUrl");
    expect(source).not.toContain(
      'itemCondition: "https://schema.org/NewCondition"',
    );
    expect(source).toContain("sellerSchemaName");
    expect(source).toContain("layoutData.business?.companyName");
    expect(source).toContain("layoutData.business?.legalName");
    expect(source).not.toContain("layoutData?.footer?.copyrightText");
    expect(source).not.toContain("layoutData?.header?.logo?.alt");
    expect(source).not.toContain('||\n  "Store"');
    expect(source).toContain(
      "const brandName = brandAttribute?.value?.trim() || null",
    );
    expect(source).not.toContain("brandAttribute?.value || storeName");
  });
});
