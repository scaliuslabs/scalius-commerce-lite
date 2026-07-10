/**
 * Product Feed Endpoint
 * Generates XML RSS 2.0 feeds for the canonical Google/Base catalog feed
 * and the Facebook/Meta compatibility catalog feed.
 * Supports pagination for large product catalogs (?page=1&limit=1000)
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
import {
  DEFAULT_PRODUCT_OPTION_LABELS,
  DEFAULT_PRODUCT_OPTION_SCHEMA,
  normalizeProductOptionLabel,
  normalizeProductOptionSchema,
  type ProductOptionSchema,
} from "@scalius/shared/product-options";
import { normalizeSavedProductCondition } from "@scalius/shared/product-condition";
import { normalizeResourceCanonicalPath } from "@scalius/shared/seo-canonical";
import { resolveCatalogDiscoveryImageUrl } from "@scalius/shared/catalog-discovery-media";
import {
  isVariantAvailable,
  resolveBuyerVariants,
} from "@/lib/product-sellable-variants";
import { getVariantDiscountedPrice } from "@/components/product/lib/pricing-engine";

export const prerender = false;

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;
const API_FEED_PAGE_SIZE = 100;
const API_FEED_BATCH_SIZE = 5;
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
type VariantOptionAxis = "option1" | "option2";

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

function decodeHtmlEntities(text: string): string {
  return text.replace(
    /&(#\d+|#x[\da-f]+|amp|lt|gt|quot|apos|nbsp);/gi,
    (match, entity: string) => {
      const normalized = entity.toLowerCase();
      if (normalized === "amp") return "&";
      if (normalized === "lt") return "<";
      if (normalized === "gt") return ">";
      if (normalized === "quot") return '"';
      if (normalized === "apos") return "'";
      if (normalized === "nbsp") return " ";

      const codePoint = normalized.startsWith("#x")
        ? Number.parseInt(normalized.slice(2), 16)
        : Number.parseInt(normalized.slice(1), 10);
      if (!Number.isFinite(codePoint)) return match;

      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    },
  );
}

function toPlainFeedDescription(text: string | null | undefined): string {
  if (!text) return "";

  return decodeHtmlEntities(
    text
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/(?:p|div|li|h[1-6]|tr|td|th|section|article)>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .replace(/\s+([.,;:!?])/g, "$1")
      .trim(),
  );
}

/**
 * Formats price for Facebook feed (number + space + currency).
 * Uses ISO 4217 decimal places per currency (e.g., JPY=0, BDT/USD=2, BHD=3).
 */
function formatFeedPrice(price: number, currencyCode: string): string {
  const decimals =
    currencyCode === "JPY" || currencyCode === "KRW" || currencyCode === "VND"
      ? 0
      : currencyCode === "BHD" ||
          currencyCode === "KWD" ||
          currencyCode === "OMR"
        ? 3
        : 2; // Most currencies use 2 decimals
  return `${price.toFixed(decimals)} ${currencyCode}`;
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

function getProductOptionSchema(
  product: Product,
  axis: VariantOptionAxis,
): ProductOptionSchema {
  return normalizeProductOptionSchema(
    axis === "option1"
      ? product.variantOption1Schema
      : product.variantOption2Schema,
    axis === "option1"
      ? DEFAULT_PRODUCT_OPTION_SCHEMA.option1
      : DEFAULT_PRODUCT_OPTION_SCHEMA.option2,
  );
}

function getProductOptionLabel(product: Product, axis: VariantOptionAxis): string {
  return normalizeProductOptionLabel(
    axis === "option1"
      ? product.variantOption1Label
      : product.variantOption2Label,
    axis === "option1"
      ? DEFAULT_PRODUCT_OPTION_LABELS.option1
      : DEFAULT_PRODUCT_OPTION_LABELS.option2,
  );
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

function getPrimaryImageLink(product: Product, baseUrl: string): string | null {
  const sourceImage = product.imageUrl?.trim();
  if (!sourceImage) {
    return null;
  }

  return resolveCatalogDiscoveryImageUrl(sourceImage, baseUrl, {
    transformImageUrl: (imageUrl) =>
      getOptimizedImageUrl(imageUrl, FEED_IMAGE_OPTIONS),
  });
}

function toFeedProductRow(product: Product, baseUrl: string): FeedProductRow | null {
  if (product.isActive === false) {
    return null;
  }

  const imageLink = getPrimaryImageLink(product, baseUrl);
  if (!imageLink) {
    return null;
  }

  return { kind: "product", product, imageLink };
}

function toFeedVariantRow(
  product: Product,
  variant: ProductVariant,
  baseUrl: string,
): FeedVariantRow | null {
  if (product.isActive === false) {
    return null;
  }

  const imageLink = getPrimaryImageLink(product, baseUrl);
  if (!imageLink) {
    return null;
  }

  return { kind: "variant", product, variant, imageLink };
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
  feedsPolicy: SeoDiscoverySettings["feeds"],
  variantStrategy = getFeedVariantStrategy(feedsPolicy),
): FeedItem[] {
  return products.flatMap<FeedItem>((product) => {
    if (variantStrategy === "products") {
      if (!shouldIncludeProductRow(product, feedsPolicy)) {
        return [];
      }

      const feedProduct = toFeedProductRow(product, baseUrl);
      return feedProduct ? [feedProduct] : [];
    }

    const buyerVariantResolution = resolveBuyerVariants(getProductVariants(product));
    if (buyerVariantResolution.mode === "optioned") {
      return buyerVariantResolution.variants.flatMap((variant) => {
        if (!shouldIncludeVariantRow(product, variant, feedsPolicy)) {
          return [];
        }

        const feedVariant = toFeedVariantRow(product, variant, baseUrl);
        return feedVariant ? [feedVariant] : [];
      });
    }

    if (product.hasVariants) {
      return [];
    }

    if (!shouldIncludeProductRow(product, feedsPolicy)) {
      return [];
    }

    const feedProduct = toFeedProductRow(product, baseUrl);
    return feedProduct ? [feedProduct] : [];
  });
}

function buildFeedItemUrl(feedItem: FeedItem, baseUrl: string): string {
  const productPath =
    normalizeResourceCanonicalPath("product", feedItem.product.canonicalPath) ??
    `/products/${feedItem.product.slug}`;
  const productUrl = new URL(productPath, `${baseUrl}/`);
  if (feedItem.kind === "variant") {
    const size = normalizedOption(feedItem.variant.size);
    const color = normalizedOption(feedItem.variant.color);
    if (size) productUrl.searchParams.set("size", size);
    if (color) productUrl.searchParams.set("color", color);
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

  const optionLabels = [
    {
      axis: "option1" as const,
      value: normalizedOption(feedItem.variant.size),
    },
    {
      axis: "option2" as const,
      value: normalizedOption(feedItem.variant.color),
    },
  ]
    .filter((option) => Boolean(option.value))
    .map((option) => `${getProductOptionLabel(feedItem.product, option.axis)}: ${option.value}`);

  return optionLabels.length > 0
    ? `${feedItem.product.name} - ${optionLabels.join(" / ")}`
    : feedItem.product.name;
}

function getFeedItemGroupTitle(product: Product): string {
  return product.name.trim().slice(0, 150) || product.name;
}

function getVariantOptionPairs(
  product: Product,
  variant: ProductVariant,
): Array<{ name: string; value: string }> {
  return [
    {
      axis: "option1" as const,
      value: normalizedOption(variant.size),
    },
    {
      axis: "option2" as const,
      value: normalizedOption(variant.color),
    },
  ].flatMap((option) => {
    if (!option.value) {
      return [];
    }

    return [
      {
        name: getProductOptionLabel(product, option.axis).slice(0, 250),
        value: option.value.slice(0, 250),
      },
    ];
  });
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

function getFeedItemPricing(feedItem: FeedItem): {
  basePrice: number;
  feedPrice: number;
} {
  const { product } = feedItem;
  if (feedItem.kind === "variant") {
    const basePrice = feedItem.variant.price ?? product.price;
    return {
      basePrice,
      feedPrice: getVariantDiscountedPrice(
        feedItem.variant.price,
        product.price,
        feedItem.variant.discountType,
        feedItem.variant.discountPercentage,
        feedItem.variant.discountAmount,
        product.discountType,
        product.discountPercentage,
        product.discountAmount,
      ),
    };
  }

  return {
    basePrice: product.price,
    feedPrice: product.discountedPrice ?? product.price,
  };
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
  const { basePrice, feedPrice } = getFeedItemPricing(feedItem);
  const formattedBasePrice = formatFeedPrice(basePrice, currencyCode);
  const formattedFeedPrice = formatFeedPrice(feedPrice, currencyCode);

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
  if (feedPrice < basePrice && formattedFeedPrice !== formattedBasePrice) {
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
    const optionValues = [
      {
        axis: "option1" as const,
        value: normalizedOption(feedItem.variant.size),
      },
      {
        axis: "option2" as const,
        value: normalizedOption(feedItem.variant.color),
      },
    ];
    const emittedOptionSchemas = new Set<ProductOptionSchema>();
    for (const option of optionValues) {
      if (!option.value) continue;
      const optionSchema = getProductOptionSchema(product, option.axis);
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
    item += `    <g:shipping>\n`;
    item += `      <g:country>BD</g:country>\n`;
    item += `      <g:service>Standard</g:service>\n`;
    item += `      <g:price>0.00 ${currencyCode}</g:price>\n`;
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
  | { status: "ok"; items: FeedItem[] }
  | { status: "unavailable" };

function appendFeedItemsForWindow(
  pageItems: FeedItem[],
  state: { seen: number; items: FeedItem[] },
  targetStart: number,
  targetEnd: number,
) {
  const nextSeen = state.seen + pageItems.length;
  if (nextSeen <= targetStart) {
    state.seen = nextSeen;
    return;
  }

  const startIndex = Math.max(0, targetStart - state.seen);
  const endIndex = Math.min(pageItems.length, targetEnd - state.seen);
  if (endIndex > startIndex) {
    state.items.push(...pageItems.slice(startIndex, endIndex));
  }
  state.seen = nextSeen;
}

async function readFeedItemWindow({
  page,
  limit,
  baseUrl,
  feedsPolicy,
  feedVariantStrategy,
}: {
  page: number;
  limit: number;
  baseUrl: string;
  feedsPolicy: SeoDiscoverySettings["feeds"];
  feedVariantStrategy: ReturnType<typeof getFeedVariantStrategy>;
}): Promise<FeedItemWindowResult> {
  const targetStart = (page - 1) * limit;
  const targetEnd = targetStart + limit;
  const state = { seen: 0, items: [] as FeedItem[] };

  const firstResponse = await getFeedProducts({
    page: 1,
    limit: API_FEED_PAGE_SIZE,
  });
  if (!firstResponse) {
    return { status: "unavailable" };
  }

  appendFeedItemsForWindow(
    toFeedItems(firstResponse.data, baseUrl, feedsPolicy, feedVariantStrategy),
    state,
    targetStart,
    targetEnd,
  );

  const totalPages = firstResponse.pagination.totalPages;
  for (
    let currentApiPage = 2;
    currentApiPage <= totalPages && state.items.length < limit;
    currentApiPage += API_FEED_BATCH_SIZE
  ) {
    const endBatchPage = Math.min(
      currentApiPage + API_FEED_BATCH_SIZE - 1,
      totalPages,
    );
    const batchResponses = await Promise.all(
      Array.from(
        { length: endBatchPage - currentApiPage + 1 },
        (_, index) =>
          getFeedProducts({
            page: currentApiPage + index,
            limit: API_FEED_PAGE_SIZE,
          }),
      ),
    );

    for (const response of batchResponses) {
      if (state.items.length >= limit) break;
      if (!response) {
        return { status: "unavailable" };
      }

      appendFeedItemsForWindow(
        toFeedItems(response.data, baseUrl, feedsPolicy, feedVariantStrategy),
        state,
        targetStart,
        targetEnd,
      );
    }
  }

  return { status: "ok", items: state.items };
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

      const pageParam = url.searchParams.get("page");
      const limitParam = url.searchParams.get("limit");

      const page = parsePositiveIntegerParam(
        pageParam,
        1,
        Number.MAX_SAFE_INTEGER,
      );
      const limit = parsePositiveIntegerParam(
        limitParam,
        DEFAULT_LIMIT,
        MAX_LIMIT,
      );

      if (page === null) {
        return new Response("Invalid page parameter", { status: 400 });
      }

      if (limit === null) {
        return new Response("Invalid limit parameter", { status: 400 });
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
        page,
        limit,
        baseUrl,
        feedsPolicy,
        feedVariantStrategy,
      });
      if (feedWindow.status === "unavailable") {
        return xmlDataUnavailableResponse(
          `${feedLabel} is temporarily unavailable`,
        );
      }

      if (feedWindow.items.length === 0 && page > 1) {
        return new Response("Page not found", { status: 404 });
      }

      const xml = generateCatalogFeed(
        feedWindow.items,
        baseUrl,
        currencyCode,
        feedsPolicy,
        format,
      );

      return new Response(xml, {
        status: 200,
        headers: FEED_XML_HEADERS,
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
