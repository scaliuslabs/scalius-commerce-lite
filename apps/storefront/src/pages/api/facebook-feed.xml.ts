/**
 * Product Feed Endpoint
 * Generates XML RSS 2.0 feeds for the canonical Google/Base catalog feed
 * and the Facebook/Meta compatibility catalog feed.
 * Supports bounded product continuation for large catalogs (?cursor=...&limit=1000)
 */

import type { APIRoute, APIContext } from "astro";
import { getFeedProducts } from "@/lib/api/products";
import type { Product } from "@/lib/api/types";
import { getLayoutData, getSeoSettings, getShippingMethods } from "@/lib/api";
import type { ShippingMethod } from "@/lib/api/types";
import { splitDeliveryRates } from "@/lib/delivery-facts";
import { formatCatalogFeedAmount } from "@scalius/shared/catalog-feed-money";
import { setRuntimeImageCdnPolicy } from "@/lib/api/runtime";
import { resolveMediaUrl } from "@/lib/media-url";
import { getBaseUrl, xmlDataUnavailableResponse } from "@/lib/sitemap-utils";
import { resolveStoreName } from "@/lib/store-identity";
import {
  normalizeSeoDiscoverySettings,
  type SeoDiscoverySettings,
} from "@scalius/shared/seo-discovery";
import {
  projectCatalogFeedRows,
  type CatalogFeedFormat,
  type CatalogFeedRow,
  type CatalogFeedVariantStrategy,
} from "@scalius/shared/catalog-feed-row";

export const prerender = false;

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;
const API_FEED_PAGE_SIZE = 100;
const FEED_XML_HEADERS = {
  "Content-Type": "application/xml; charset=utf-8",
  "Cache-Control": "public, max-age=3600, stale-while-revalidate=43200",
} as const;

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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getFeedVariantStrategy(
  feedsPolicy: SeoDiscoverySettings["feeds"],
  discovery?: unknown,
): CatalogFeedVariantStrategy {
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

function toCatalogFeedRows(
  products: Product[],
  baseUrl: string,
  currencyCode: string,
  feedsPolicy: SeoDiscoverySettings["feeds"],
  variantStrategy = getFeedVariantStrategy(feedsPolicy),
): CatalogFeedRow[] {
  return projectCatalogFeedRows({
    products,
    storefrontBaseUrl: baseUrl,
    currencyCode,
    policy: {
      variantStrategy,
      includeUnavailableProducts: feedsPolicy.includeUnavailableProducts,
    },
    resolveImageUrl: resolveMediaUrl,
  }).rows;
}

interface FeedShipping {
  service: string;
  price: string;
}

/**
 * Store-wide delivery charges, the same ones Product JSON-LD states: every
 * active delivery rate when rates don't vary by delivery zone. With zones the
 * charge depends on the address, so none is claimed (use Merchant Center
 * account-level shipping), exactly like the product page.
 */
function storeFeedShipping(
  shippingMethods: ShippingMethod[] | null,
  currencyCode: string,
): FeedShipping[] {
  const { delivery, zoned } = splitDeliveryRates(shippingMethods);
  if (zoned) return [];
  return delivery.flatMap((method) => {
    const amount = formatCatalogFeedAmount(method.fee, currencyCode);
    return amount ? [{ service: method.name, price: `${amount} ${currencyCode}` }] : [];
  });
}

/**
 * Generates a single product item for the feed
 */
function generateProductItem(
  row: CatalogFeedRow,
  format: CatalogFeedFormat,
  storeShipping: FeedShipping[],
): string {
  // Build the item XML
  let item = "  <item>\n";

  // Required fields
  item += `    <g:id>${escapeXml(row.id)}</g:id>\n`;
  item += `    <g:title>${escapeXml(row.title)}</g:title>\n`;
  item += `    <g:description>${escapeXml(row.description)}</g:description>\n`;
  item += `    <g:link>${escapeXml(row.link)}</g:link>\n`;
  item += `    <g:availability>${row.availability[format]}</g:availability>\n`;
  if (row.condition) {
    item += `    <g:condition>${row.condition}</g:condition>\n`;
  }
  item += `    <g:price>${row.pricing.price}</g:price>\n`;

  // Image (required)
  item += `    <g:image_link>${escapeXml(row.imageLink)}</g:image_link>\n`;

  if (row.brand) {
    item += `    <g:brand>${escapeXml(row.brand)}</g:brand>\n`;
  }
  if (row.gtin) {
    item += `    <g:gtin>${escapeXml(row.gtin)}</g:gtin>\n`;
  }
  if (row.identifierExists) {
    item += `    <g:identifier_exists>${row.identifierExists}</g:identifier_exists>\n`;
  }

  // Optional fields

  // Sale price if there's a discount
  if (row.pricing.salePrice) {
    item += `    <g:sale_price>${row.pricing.salePrice}</g:sale_price>\n`;
  }

  // Item group ID for variants
  if (row.itemGroupId) {
    item += `    <g:item_group_id>${escapeXml(row.itemGroupId)}</g:item_group_id>\n`;
  }
  if (format === "google" && row.itemGroupTitle) {
    item += `    <g:item_group_title>${escapeXml(row.itemGroupTitle)}</g:item_group_title>\n`;
    for (const option of row.variantOptions) {
      item += "    <g:variant_option>\n";
      item += `      <g:name>${escapeXml(option.name)}</g:name>\n`;
      item += `      <g:value>${escapeXml(option.value)}</g:value>\n`;
      item += "    </g:variant_option>\n";
    }
  }

  // Categories
  if (row.googleProductCategory) {
    item += `    <g:google_product_category>${escapeXml(row.googleProductCategory)}</g:google_product_category>\n`;
  }
  if (row.facebookProductCategory) {
    item += `    <g:fb_product_category>${escapeXml(row.facebookProductCategory)}</g:fb_product_category>\n`;
  }
  if (row.productType) {
    item += `    <g:product_type>${escapeXml(row.productType)}</g:product_type>\n`;
  }

  for (const attribute of row.standardAttributes) {
    item += `    <g:${attribute.name}>${escapeXml(attribute.value)}</g:${attribute.name}>\n`;
  }

  // A free-delivery product ships free everywhere; other items carry the
  // store-wide delivery charges.
  const shipping = row.shipping ? [row.shipping] : storeShipping;
  for (const rate of shipping) {
    item += `    <g:shipping>\n`;
    item += `      <g:country>BD</g:country>\n`;
    item += `      <g:service>${escapeXml(rate.service)}</g:service>\n`;
    item += `      <g:price>${rate.price}</g:price>\n`;
    item += `    </g:shipping>\n`;
  }

  item += "  </item>\n";
  return item;
}

/**
 * Generates a complete catalog feed.
 */
function generateCatalogFeed(
  rows: CatalogFeedRow[],
  baseUrl: string,
  feedsPolicy: SeoDiscoverySettings["feeds"],
  format: CatalogFeedFormat,
  storeName: string | null,
  storeShipping: FeedShipping[],
): string {
  const title = feedsPolicy.title || storeName || "Product catalog";
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

  for (const row of rows) {
    xml += generateProductItem(row, format, storeShipping);
  }

  xml += "</channel>\n";
  xml += "</rss>";
  return xml;
}

type FeedItemWindowResult =
  | { status: "ok"; items: CatalogFeedRow[]; cursor?: string }
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
  const items: CatalogFeedRow[] = [];
  let remainingProducts = limit;
  let nextCursor = cursor;

  do {
    const response = await getFeedProducts({
      ...(nextCursor ? { cursor: nextCursor } : {}),
      limit: Math.min(API_FEED_PAGE_SIZE, remainingProducts),
    });
    if (!response) return { status: "unavailable" };

    items.push(...toCatalogFeedRows(
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

export function createCatalogFeedGet(format: CatalogFeedFormat): APIRoute {
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

      const [layoutData, shippingMethods] = await Promise.all([
        getLayoutData(),
        getShippingMethods(),
      ]);
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
        feedsPolicy,
        format,
        resolveStoreName(layoutData.business),
        storeFeedShipping(shippingMethods, currencyCode),
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
