/**
 * Product Feed Endpoint
 * Generates XML RSS 2.0 feeds for the canonical Google/Base catalog feed
 * and the Facebook/Meta compatibility catalog feed.
 * Supports bounded product continuation for large catalogs (?cursor=...&limit=1000)
 */

import type { APIRoute, APIContext } from "astro";
import { getFeedProducts } from "@/lib/api/products";
import type { Product, ProductVariant } from "@/lib/api/types";
import {
  getGoogleCategory,
  getFacebookCategory,
  escapeXmlCategory,
} from "@/lib/category-mapping";
import { getLayoutData, getSeoSettings } from "@/lib/api";
import { setRuntimeImageCdnPolicy } from "@/lib/api/runtime-env";
import { getOptimizedImageUrl } from "@/lib/image-optimizer";
import { getBaseUrl, xmlDataUnavailableResponse } from "@/lib/sitemap-utils";
import {
  normalizeSeoDiscoverySettings,
  type SeoDiscoverySettings,
} from "@scalius/shared/seo-discovery";
import { normalizeSavedProductCondition } from "@scalius/shared/product-condition";
import { normalizeResourceCanonicalPath } from "@scalius/shared/seo-canonical";
import { resolveCatalogDiscoveryImageUrl } from "@scalius/shared/catalog-discovery-media";
import {
  calculateCatalogFeedDiscountedAmount,
  formatCatalogFeedAmount,
  isCatalogFeedSalePrice,
  isPositiveCatalogFeedAmount,
} from "@scalius/shared/catalog-feed-money";
import {
  isVariantAvailable,
  resolveBuyerVariants,
} from "@/lib/product-sellable-variants";
import { htmlToPlainText } from "@scalius/shared/html-sanitize";

export const prerender = false;

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;
const API_FEED_PAGE_SIZE = 100;
const FEED_IMAGE_OPTIONS = {
  width: 1200,
  quality: 90,
  format: "auto",
  fit: "scale-down",
} as const;
const FEED_XML_HEADERS = {
  "Content-Type": "application/xml; charset=utf-8",
  "Cache-Control": "public, max-age=3600, stale-while-revalidate=43200",
} as const;

type FeedProductRow = {
  kind: "product";
  product: Product;
  imageLink: string;
};

type FeedVariantRow = {
  kind: "variant";
  product: Product;
  variant: ProductVariant;
  imageLink: string;
};

type FeedItem = FeedProductRow | FeedVariantRow;
type FeedFormat = "google" | "meta";
type FeedAvailability = "in_stock" | "out_of_stock";
type ProductOptionSchema = "size" | "color" | "material" | "pattern" | "none";

/**
 * Escapes XML special characters
 */
function escapeXml(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function toPlainFeedDescription(text: string | null | undefined): string {
  return htmlToPlainText(text);
}

/**
 * Formats catalog-feed money as number + space + currency.
 * Google accepts at most two fractional digits, even for currencies whose
 * normal cash precision is higher.
 */
function formatFeedPrice(
  price: number,
  currencyCode: string,
): string | null {
  const formattedAmount = formatCatalogFeedAmount(price, currencyCode);
  return formattedAmount === null
    ? null
    : `${formattedAmount} ${currencyCode}`;
}

/**
 * Determines catalog availability from the storefront buyer availability signal.
 */
function getAvailability(product: Product): FeedAvailability {
  if (product.isActive === false) {
    return "out_of_stock";
  }

  return product.availableForSale === false ? "out_of_stock" : "in_stock";
}

function getVariantAvailability(
  product: Product,
  variant: ProductVariant,
): FeedAvailability {
  if (product.isActive === false) {
    return "out_of_stock";
  }

  return isVariantAvailable(variant) ? "in_stock" : "out_of_stock";
}

function formatFeedAvailability(
  availability: FeedAvailability,
  format: FeedFormat,
): string {
  if (format === "meta") {
    return availability === "in_stock" ? "in stock" : "out of stock";
  }
  return availability;
}

function normalizedOption(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getFeedVariantStrategy(
  feedsPolicy: SeoDiscoverySettings["feeds"],
  discovery?: unknown,
): "products" | "variants" {
  const rawFeeds = asRecord(asRecord(discovery).feeds);
  const rawPolicy = feedsPolicy as SeoDiscoverySettings["feeds"] & {
    variantMode?: unknown;
    variantStrategy?: unknown;
  };
  const value =
    rawFeeds.variantStrategy ??
    rawFeeds.variantMode ??
    rawPolicy.variantStrategy ??
    rawPolicy.variantMode;
  return value === "products" || value === "product" ? "products" : "variants";
}

function parsePositiveIntegerParam(
  value: string | null,
  fallback: number,
  max: number,
): number | null {
  if (value === null) return fallback;
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return null;
  return Math.min(parsed, max);
}

function getProductVariants(product: Product): ProductVariant[] {
  return Array.isArray(product.variants) ? product.variants : [];
}

function getCatalogImageLink(
  imageUrl: string | null | undefined,
  baseUrl: string,
): string | null {
  const sourceImage = imageUrl?.trim();
  if (!sourceImage) {
    return null;
  }

  return resolveCatalogDiscoveryImageUrl(sourceImage, baseUrl, {
    transformImageUrl: (imageUrl) =>
      getOptimizedImageUrl(imageUrl, FEED_IMAGE_OPTIONS),
  });
}

function getPrimaryImageLink(product: Product, baseUrl: string): string | null {
  return getCatalogImageLink(product.imageUrl, baseUrl);
}

function getVariantImageLink(
  product: Product,
  variant: ProductVariant,
  baseUrl: string,
): string | null {
  return (
    (variant.imageId
      ? getCatalogImageLink(variant.imageUrl, baseUrl)
      : null) ??
    getPrimaryImageLink(product, baseUrl)
  );
}

function toFeedProductRow(
  product: Product,
  baseUrl: string,
  currencyCode: string,
): FeedProductRow | null {
  if (product.isActive === false) {
    return null;
  }

  const imageLink = getPrimaryImageLink(product, baseUrl);
  if (!imageLink) {
    return null;
  }

  const feedItem: FeedProductRow = { kind: "product", product, imageLink };
  return hasPositiveFeedPricing(feedItem, currencyCode) ? feedItem : null;
}

function toFeedVariantRow(
  product: Product,
  variant: ProductVariant,
  baseUrl: string,
  currencyCode: string,
): FeedVariantRow | null {
  if (product.isActive === false) {
    return null;
  }

  const imageLink = getVariantImageLink(product, variant, baseUrl);
  if (!imageLink) {
    return null;
  }

  const feedItem: FeedVariantRow = {
    kind: "variant",
    product,
    variant,
    imageLink,
  };
  return hasPositiveFeedPricing(feedItem, currencyCode) ? feedItem : null;
}

function shouldIncludeProductRow(
  product: Product,
  feedsPolicy: SeoDiscoverySettings["feeds"],
): boolean {
  return (
    feedsPolicy.includeUnavailableProducts ||
    getAvailability(product) === "in_stock"
  );
}

function shouldIncludeVariantRow(
  product: Product,
  variant: ProductVariant,
  feedsPolicy: SeoDiscoverySettings["feeds"],
): boolean {
  return (
    feedsPolicy.includeUnavailableProducts ||
    getVariantAvailability(product, variant) === "in_stock"
  );
}

function toFeedItems(
  products: Product[],
  baseUrl: string,
  currencyCode: string,
  feedsPolicy: SeoDiscoverySettings["feeds"],
  variantStrategy = getFeedVariantStrategy(feedsPolicy),
): FeedItem[] {
  return products.flatMap<FeedItem>((product) => {
    if (variantStrategy === "products") {
      if (!shouldIncludeProductRow(product, feedsPolicy)) {
        return [];
      }

      const feedProduct = toFeedProductRow(product, baseUrl, currencyCode);
      return feedProduct ? [feedProduct] : [];
    }

    const buyerVariantResolution = resolveBuyerVariants(getProductVariants(product));
    if (buyerVariantResolution.mode === "optioned") {
      return buyerVariantResolution.variants.flatMap((variant) => {
        if (!shouldIncludeVariantRow(product, variant, feedsPolicy)) {
          return [];
        }

        const feedVariant = toFeedVariantRow(
          product,
          variant,
          baseUrl,
          currencyCode,
        );
        return feedVariant ? [feedVariant] : [];
      });
    }

    if (product.hasVariants) {
      return [];
    }

    if (!shouldIncludeProductRow(product, feedsPolicy)) {
      return [];
    }

    const feedProduct = toFeedProductRow(product, baseUrl, currencyCode);
    return feedProduct ? [feedProduct] : [];
  });
}

function buildFeedItemUrl(feedItem: FeedItem, baseUrl: string): string {
  const productPath =
    normalizeResourceCanonicalPath("product", feedItem.product.canonicalPath) ??
    `/products/${feedItem.product.slug}`;
  const productUrl = new URL(productPath, `${baseUrl}/`);
  if (feedItem.kind === "variant") {
    productUrl.searchParams.set("variant", feedItem.variant.id);
  }
  return productUrl.toString();
}

function getFeedItemId(feedItem: FeedItem): string {
  if (feedItem.kind === "variant") {
    return normalizedOption(feedItem.variant.sku) ?? feedItem.variant.id;
  }
  return feedItem.product.id;
}

function getFeedItemAvailability(feedItem: FeedItem): FeedAvailability {
  if (feedItem.kind === "variant") {
    return getVariantAvailability(feedItem.product, feedItem.variant);
  }
  return getAvailability(feedItem.product);
}

function getFeedItemTitle(feedItem: FeedItem): string {
  if (feedItem.kind !== "variant") {
    return feedItem.product.name;
  }

  const optionLabels = feedItem.variant.selectedOptions
    .map((option) => `${option.name}: ${option.value}`);

  return optionLabels.length > 0
    ? `${feedItem.product.name} - ${optionLabels.join(" / ")}`
    : feedItem.product.name;
}

function getFeedItemGroupTitle(product: Product): string {
  return product.name.trim().slice(0, 150) || product.name;
}

function getVariantOptionPairs(
  _product: Product,
  variant: ProductVariant,
): Array<{ name: string; value: string }> {
  return variant.selectedOptions.map((option) => ({
    name: option.name.slice(0, 250),
    value: option.value.slice(0, 250),
  }));
}

function getSupportedVariantGtin(variant: ProductVariant): string | null {
  const barcode = variant.barcode?.trim();
  if (!barcode) {
    return null;
  }

  switch (variant.barcodeType) {
    case "ean13":
    case "upc":
    case "isbn":
    case "gtin":
      return barcode;
    default:
      return null;
  }
}

function getFeedItemGtin(feedItem: FeedItem): string | null {
  if (feedItem.kind === "variant") {
    return getSupportedVariantGtin(feedItem.variant);
  }

  const buyerVariantResolution = resolveBuyerVariants(
    getProductVariants(feedItem.product),
  );
  if (buyerVariantResolution.mode !== "simple") {
    return null;
  }

  return getSupportedVariantGtin(buyerVariantResolution.variants[0]!);
}

function getFeedItemPricing(feedItem: FeedItem, currencyCode: string): {
  basePrice: number;
  feedPrice: number;
} {
  const { product } = feedItem;
  const variant = feedItem.kind === "variant" ? feedItem.variant : null;
  const basePrice = variant?.price ?? product.price;
  const variantHasDiscount =
    (variant?.discountType === "percentage" &&
      (variant.discountPercentage ?? 0) > 0) ||
    (variant?.discountType === "flat" && (variant.discountAmount ?? 0) > 0);
  const discount = variantHasDiscount && variant ? variant : product;

  return {
    basePrice,
    feedPrice: calculateCatalogFeedDiscountedAmount(
      basePrice,
      discount.discountType,
      discount.discountPercentage,
      discount.discountAmount,
      currencyCode,
    ),
  };
}

function hasPositiveFeedPricing(
  feedItem: FeedItem,
  currencyCode: string,
): boolean {
  const { basePrice, feedPrice } = getFeedItemPricing(feedItem, currencyCode);
  return (
    isPositiveCatalogFeedAmount(basePrice, currencyCode) &&
    isPositiveCatalogFeedAmount(feedPrice, currencyCode)
  );
}

/**
 * Generates a single product item for the feed
 */
function generateProductItem(
  feedItem: FeedItem,
  baseUrl: string,
  currencyCode: string,
  format: FeedFormat,
): string {
  const { product, imageLink } = feedItem;
  const productUrl = buildFeedItemUrl(feedItem, baseUrl);
  const availability = formatFeedAvailability(
    getFeedItemAvailability(feedItem),
    format,
  );
  const { basePrice, feedPrice } = getFeedItemPricing(feedItem, currencyCode);
  const formattedBasePrice = formatFeedPrice(basePrice, currencyCode);
  const formattedFeedPrice = formatFeedPrice(feedPrice, currencyCode);
  if (formattedBasePrice === null || formattedFeedPrice === null) {
    return "";
  }

  // Get category mappings
  const categorySlug = product.category?.slug || "";
  const categoryName = product.category?.name || "";
  const googleCategory = getGoogleCategory(categorySlug);
  const facebookCategory = getFacebookCategory(categorySlug);

  // Build the item XML
  let item = "  <item>\n";

  // Required fields
  item += `    <g:id>${escapeXml(getFeedItemId(feedItem))}</g:id>\n`;
  item += `    <g:title>${escapeXml(getFeedItemTitle(feedItem))}</g:title>\n`;
  item += `    <g:description>${escapeXml(toPlainFeedDescription(product.description) || product.name)}</g:description>\n`;
  item += `    <g:link>${escapeXml(productUrl)}</g:link>\n`;
  item += `    <g:availability>${availability}</g:availability>\n`;
  const condition = normalizeSavedProductCondition(product.productCondition);
  if (condition) {
    item += `    <g:condition>${condition}</g:condition>\n`;
  }
  item += `    <g:price>${formattedBasePrice}</g:price>\n`;

  // Image (required)
  item += `    <g:image_link>${escapeXml(imageLink)}</g:image_link>\n`;

  // Brand - try to get from attributes
  const brandAttribute = product.attributes?.find(
    (attr) => attr.name.toLowerCase() === "brand",
  );
  const brand = brandAttribute?.value?.trim() || null;
  const gtin = getFeedItemGtin(feedItem);
  if (brand) {
    item += `    <g:brand>${escapeXml(brand)}</g:brand>\n`;
  }
  if (gtin) {
    item += `    <g:gtin>${escapeXml(gtin)}</g:gtin>\n`;
  }
  if (!brand && !gtin) {
    item += "    <g:identifier_exists>no</g:identifier_exists>\n";
  }

  // Optional fields

  // Sale price if there's a discount
  if (isCatalogFeedSalePrice(basePrice, feedPrice, currencyCode)) {
    item += `    <g:sale_price>${formattedFeedPrice}</g:sale_price>\n`;
  }

  // Item group ID for variants
  if (feedItem.kind === "variant" || product.hasVariants) {
    item += `    <g:item_group_id>${escapeXml(product.id)}</g:item_group_id>\n`;
  }
  if (format === "google" && feedItem.kind === "variant") {
    item += `    <g:item_group_title>${escapeXml(getFeedItemGroupTitle(product))}</g:item_group_title>\n`;
    for (const option of getVariantOptionPairs(product, feedItem.variant)) {
      item += "    <g:variant_option>\n";
      item += `      <g:name>${escapeXml(option.name)}</g:name>\n`;
      item += `      <g:value>${escapeXml(option.value)}</g:value>\n`;
      item += "    </g:variant_option>\n";
    }
  }

  // Categories
  if (googleCategory) {
    item += `    <g:google_product_category>${escapeXmlCategory(googleCategory)}</g:google_product_category>\n`;
  }
  if (facebookCategory) {
    item += `    <g:fb_product_category>${escapeXmlCategory(facebookCategory)}</g:fb_product_category>\n`;
  }
  if (categoryName.trim()) {
    item += `    <g:product_type>${escapeXml(categoryName)}</g:product_type>\n`;
  }

  if (feedItem.kind === "variant") {
    const optionValues = feedItem.variant.selectedOptions.map((option) => ({
      schema: option.standardMapping,
      value: normalizedOption(option.value),
    }));
    const emittedOptionSchemas = new Set<ProductOptionSchema>();
    for (const option of optionValues) {
      if (!option.value) continue;
      const optionSchema = option.schema;
      if (optionSchema === "none" || emittedOptionSchemas.has(optionSchema)) {
        continue;
      }
      emittedOptionSchemas.add(optionSchema);
      item += `    <g:${optionSchema}>${escapeXml(option.value)}</g:${optionSchema}>\n`;
    }
  }

  // Additional attributes
  if (product.attributes && product.attributes.length > 0) {
    product.attributes.forEach((attr) => {
      const attrName = attr.name.toLowerCase();

      if (
        feedItem.kind !== "variant" &&
        (attrName === "color" || attrName === "colour")
      ) {
        item += `    <g:color>${escapeXml(attr.value)}</g:color>\n`;
      } else if (feedItem.kind !== "variant" && attrName === "size") {
        item += `    <g:size>${escapeXml(attr.value)}</g:size>\n`;
      } else if (attrName === "material") {
        item += `    <g:material>${escapeXml(attr.value)}</g:material>\n`;
      } else if (attrName === "gender") {
        item += `    <g:gender>${escapeXml(attr.value)}</g:gender>\n`;
      } else if (attrName === "age_group" || attrName === "age group") {
        item += `    <g:age_group>${escapeXml(attr.value)}</g:age_group>\n`;
      } else if (attrName === "pattern") {
        item += `    <g:pattern>${escapeXml(attr.value)}</g:pattern>\n`;
      }
    });
  }

  // Free shipping overlay
  if (product.freeDelivery) {
    const freeShippingPrice = formatFeedPrice(0, currencyCode);
    if (freeShippingPrice === null) return "";
    item += `    <g:shipping>\n`;
    item += `      <g:country>BD</g:country>\n`;
    item += `      <g:service>Standard</g:service>\n`;
    item += `      <g:price>${freeShippingPrice}</g:price>\n`;
    item += `    </g:shipping>\n`;
  }

  item += "  </item>\n";
  return item;
}

/**
 * Generates a complete catalog feed.
 */
function generateCatalogFeed(
  products: FeedItem[],
  baseUrl: string,
  currencyCode: string,
  feedsPolicy: SeoDiscoverySettings["feeds"],
  format: FeedFormat,
): string {
  const title = feedsPolicy.title || "Product Catalog";
  const description =
    feedsPolicy.description ||
    (format === "meta"
      ? "Complete product catalog for Facebook/Instagram shopping"
      : "Complete product catalog for shopping feeds");

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">\n';
  xml += "<channel>\n";
  xml += `<title>${escapeXml(title)}</title>\n`;
  xml += `<link>${escapeXml(baseUrl)}</link>\n`;
  xml += `<description>${escapeXml(description)}</description>\n`;

  for (const product of products) {
    xml += generateProductItem(product, baseUrl, currencyCode, format);
  }

  xml += "</channel>\n";
  xml += "</rss>";
  return xml;
}

type FeedItemWindowResult =
  | { status: "ok"; items: FeedItem[]; cursor?: string }
  | { status: "unavailable" };

async function readFeedItemWindow({
  cursor,
  limit,
  baseUrl,
  currencyCode,
  feedsPolicy,
  feedVariantStrategy,
}: {
  cursor?: string;
  limit: number;
  baseUrl: string;
  currencyCode: string;
  feedsPolicy: SeoDiscoverySettings["feeds"];
  feedVariantStrategy: ReturnType<typeof getFeedVariantStrategy>;
}): Promise<FeedItemWindowResult> {
  const items: FeedItem[] = [];
  let remainingProducts = limit;
  let nextCursor = cursor;

  do {
    const response = await getFeedProducts({
      ...(nextCursor ? { cursor: nextCursor } : {}),
      limit: Math.min(API_FEED_PAGE_SIZE, remainingProducts),
    });
    if (!response) return { status: "unavailable" };

    items.push(...toFeedItems(
      response.data,
      baseUrl,
      currencyCode,
      feedsPolicy,
      feedVariantStrategy,
    ));
    remainingProducts -= response.data.length;
    nextCursor = response.pagination.cursor;
    if (response.data.length === 0) break;
  } while (nextCursor && remainingProducts > 0);

  return {
    status: "ok",
    items,
    ...(nextCursor ? { cursor: nextCursor } : {}),
  };
}

export function createCatalogFeedGet(format: FeedFormat): APIRoute {
  const feedLabel =
    format === "meta" ? "Facebook product feed" : "Product catalog feed";

  return async ({ url }: APIContext) => {
    try {
      let baseUrl: string;
      try {
        baseUrl = getBaseUrl();
      } catch (error) {
        console.error(`${feedLabel} base URL is not configured:`, error);
        return xmlDataUnavailableResponse(
          `${feedLabel} is temporarily unavailable`,
        );
      }
      const seo = await getSeoSettings();
      if (!seo) {
        return xmlDataUnavailableResponse(
          `${feedLabel} is temporarily unavailable`,
        );
      }
      const feedsPolicy = normalizeSeoDiscoverySettings(seo.discovery).feeds;
      const feedVariantStrategy = getFeedVariantStrategy(
        feedsPolicy,
        seo.discovery,
      );
      if (!feedsPolicy.productCatalogEnabled) {
        return new Response("Product catalog feed is disabled", {
          status: 404,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "private, no-cache, no-store, must-revalidate",
          },
        });
      }

      if (url.searchParams.has("page")) {
        return new Response("Page pagination is retired; follow the opaque cursor continuation link.", { status: 400 });
      }
      const cursor = url.searchParams.get("cursor")?.trim() || undefined;
      const limitParam = url.searchParams.get("limit");
      const limit = parsePositiveIntegerParam(
        limitParam,
        DEFAULT_LIMIT,
        MAX_LIMIT,
      );

      if (limit === null) {
        return new Response("Invalid limit parameter", { status: 400 });
      }
      if (cursor && (cursor.length > 512 || !/^feed-v1\.[0-9a-z]+\.[A-Za-z0-9_-]+$/.test(cursor))) {
        return new Response("Invalid cursor parameter", { status: 400 });
      }

      const layoutData = await getLayoutData();
      if (!layoutData) {
        return xmlDataUnavailableResponse(
          `${feedLabel} is temporarily unavailable`,
        );
      }
      setRuntimeImageCdnPolicy(layoutData.media);
      const currencyCode = layoutData.currency?.code ?? "BDT";

      const feedWindow = await readFeedItemWindow({
        cursor,
        limit,
        baseUrl,
        currencyCode,
        feedsPolicy,
        feedVariantStrategy,
      });
      if (feedWindow.status === "unavailable") {
        return xmlDataUnavailableResponse(
          `${feedLabel} is temporarily unavailable`,
        );
      }

      const xml = generateCatalogFeed(
        feedWindow.items,
        baseUrl,
        currencyCode,
        feedsPolicy,
        format,
      );

      const headers: Record<string, string> = { ...FEED_XML_HEADERS };
      if (feedWindow.cursor) {
        const continuationUrl = new URL(url);
        continuationUrl.searchParams.delete("page");
        continuationUrl.searchParams.set("cursor", feedWindow.cursor);
        continuationUrl.searchParams.set("limit", String(limit));
        headers.Link = `<${continuationUrl.toString()}>; rel="next"`;
      }
      return new Response(xml, {
        status: 200,
        headers,
      });
    } catch (error: unknown) {
      console.error(`Error generating ${feedLabel}:`, error);
      return xmlDataUnavailableResponse(
        `${feedLabel} is temporarily unavailable`,
      );
    }
  };
}

export const GET = createCatalogFeedGet("meta");
