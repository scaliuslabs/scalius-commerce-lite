/**
 * Product Feed Endpoint
 * Generates XML RSS 2.0 feeds for the canonical Google/Base catalog feed
 * and the Facebook/Meta compatibility catalog feed.
 *
 * Each URL is one complete feed file (`@scalius/shared/catalog-feed-files`):
 * the bare URL is the first, `?from=<stored start>` a later one. Merchant
 * platforms fetch one file per registered URL and follow no continuation;
 * a file lists at most the plan's `feedProductsPerRequest` products, and the
 * dashboard lists every file and offers the next before the newest is full.
 * `limit` reads only the first products of a file (release smokes and the
 * live probe).
 */

import type { APIRoute, APIContext } from "astro";
import { getFeedProducts, type FeedFilePagination } from "@/lib/api/products";
import { GOOGLE_CHANNEL_ID, META_CHANNEL_ID, type CatalogChannelId } from "@scalius/shared/sales-channels";
import type { Product } from "@/lib/api/types";
import { getLayoutData, getSeoSettings, getShippingMethods } from "@/lib/api";
import type { ShippingMethod } from "@/lib/api/types";
import { shippingMethodsForProfile, shippingMethodsForUnitPrice, splitDeliveryRates } from "@/lib/delivery-facts";
import { presenceMarketCountries } from "@/lib/checkout/shipping-country";
import { formatCatalogFeedAmount } from "@scalius/shared/catalog-feed-money";
import { parseFeedFileFrom, FEED_FILE_FROM_PARAM } from "@scalius/shared/catalog-feed-files";
import { resolvePriceIncrementMinor } from "@scalius/shared/currency-policy";
import { getRuntimePresence, setRuntimeImageCdnPolicy } from "@/lib/api/runtime";
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

/** The file size when the layout does not say (the Free plan's). */
const DEFAULT_FILE_PRODUCTS = 1000;
/** The largest `limit` the URL may spell; the plan's `feedProductsPerRequest` then bounds what is read. */
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
  priceIncrementMinor: number,
  feedsPolicy: SeoDiscoverySettings["feeds"],
  variantStrategy = getFeedVariantStrategy(feedsPolicy),
): CatalogFeedRow[] {
  return projectCatalogFeedRows({
    products,
    storefrontBaseUrl: baseUrl,
    // A presence's feed (`/en-in/api/product-feed.xml`) links to its pages.
    presence: getRuntimePresence(),
    currencyCode,
    priceIncrementMinor,
    policy: {
      variantStrategy,
      includeUnavailableProducts: feedsPolicy.includeUnavailableProducts,
    },
    resolveImageUrl: resolveMediaUrl,
  }).rows;
}

interface FeedShipping {
  country: string;
  service: string;
  price: string;
}

interface FeedShippingPolicy {
  /** The charges every item carries, per country. */
  rates: FeedShipping[];
  /** The countries a free-delivery item ships free to: those a shipping zone serves. */
  freeCountries: string[];
}

/**
 * The delivery charges the presence's feed states for one item, per country
 * its market sells to (MARKETS-DESIGN step 3b), the same ones Product JSON-LD
 * states: a country's delivery rates when its shipping zone serves every
 * address there, as the item's shipping profile pays them
 * (`shippingMethodsForProfile`) for one unit at its price. Where the charge
 * depends on the address (a region, postal codes or Bangladesh delivery
 * areas price it), on the parcel's weight or value (a profile's banded
 * rates), or on a carrier's quote, none is claimed (Merchant Center then
 * uses account-level shipping), exactly like the product page.
 */
function storeFeedShipping(
  shippingMethods: ShippingMethod[] | null,
  currencyCode: string,
  countries: readonly string[],
): FeedShippingPolicy {
  const rates: FeedShipping[] = [];
  const freeCountries: string[] = [];
  for (const country of countries) {
    const { delivery, zoned } = splitDeliveryRates(shippingMethods, [country]);
    if (delivery.length === 0) continue;
    freeCountries.push(country);
    if (zoned) continue;
    for (const method of delivery) {
      if (method.rateSource && method.rateSource !== "flat") continue;
      const amount = formatCatalogFeedAmount(method.fee, currencyCode);
      if (amount) rates.push({ country, service: method.name, price: `${amount} ${currencyCode}` });
    }
  }
  return { rates, freeCountries };
}

/**
 * Generates a single product item for the feed
 */
/** The charges one item carries: its shipping profile's, for one unit at its current price. */
function itemFeedShipping(row: CatalogFeedRow, store: FeedShippingSource): FeedShippingPolicy {
  const methods = shippingMethodsForUnitPrice(
    shippingMethodsForProfile(store.shippingMethods, row.shippingProfileId),
    row.pricing.currentAmount,
  );
  return storeFeedShipping(methods ?? null, store.currencyCode, store.countries);
}

interface FeedShippingSource {
  shippingMethods: ShippingMethod[] | null;
  currencyCode: string;
  countries: readonly string[];
}

function generateProductItem(
  row: CatalogFeedRow,
  format: CatalogFeedFormat,
  store: FeedShippingSource,
): string {
  const storeShipping = itemFeedShipping(row, store);
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

  // A free-delivery product ships free wherever a shipping zone serves the
  // market's countries; other items carry the charges stated per country.
  const freeShipping = row.shipping;
  const shipping = freeShipping
    ? storeShipping.freeCountries.map((country) => ({ country, ...freeShipping }))
    : storeShipping.rates;
  for (const rate of shipping) {
    item += `    <g:shipping>\n`;
    item += `      <g:country>${escapeXml(rate.country)}</g:country>\n`;
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
  store: FeedShippingSource,
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
  // The presence's home (`/en-in`) for a presence's feed; the root's is unchanged.
  const presence = getRuntimePresence();
  xml += `<link>${escapeXml(presence ? `${baseUrl}/${presence}` : baseUrl)}</link>\n`;
  xml += `<description>${escapeXml(description)}</description>\n`;

  for (const row of rows) {
    xml += generateProductItem(row, format, store);
  }

  xml += "</channel>\n";
  xml += "</rss>";
  return xml;
}

type FeedFileResult =
  | { status: "ok"; items: CatalogFeedRow[]; products: number; complete: boolean; file: FeedFilePagination | undefined }
  | { status: "not_found" }
  | { status: "unavailable" };

/**
 * One feed file, API page by API page within the range its stored start
 * names. A `from` that is no file's start is not found before any product read.
 */
async function readFeedFile({
  channel,
  from,
  limit,
  baseUrl,
  currencyCode,
  priceIncrementMinor,
  feedsPolicy,
  feedVariantStrategy,
}: {
  /** The sales channel the feed serves (MARKETS-DESIGN D6). */
  channel: CatalogChannelId;
  from: number;
  limit: number;
  baseUrl: string;
  currencyCode: string;
  priceIncrementMinor: number;
  feedsPolicy: SeoDiscoverySettings["feeds"];
  feedVariantStrategy: ReturnType<typeof getFeedVariantStrategy>;
}): Promise<FeedFileResult> {
  const items: CatalogFeedRow[] = [];
  let products = 0;
  let cursor: string | undefined;
  let file: FeedFilePagination | undefined;

  for (;;) {
    const response = await getFeedProducts({
      channel,
      from,
      ...(cursor ? { cursor } : {}),
      limit: Math.min(API_FEED_PAGE_SIZE, limit - products),
    });
    if (response === "not_found") return { status: "not_found" };
    // A cursor the API issued in this same request is never refused; if it is, the file is not readable now.
    if (response === "invalid_cursor" || !response) return { status: "unavailable" };
    file ??= response.pagination.file;

    items.push(...toCatalogFeedRows(
      response.data,
      baseUrl,
      currencyCode,
      priceIncrementMinor,
      feedsPolicy,
      feedVariantStrategy,
    ));
    products += response.data.length;
    cursor = response.pagination.cursor;
    if (!cursor || response.data.length === 0) return { status: "ok", items, products, complete: true, file };
    if (products >= limit) return { status: "ok", items, products, complete: false, file };
  }
}

/**
 * What a feed file says about the files (release smokes and support read
 * them): which file it is, every file that holds more products than a file
 * lists, whether the maintenance is still splitting files, and whether this
 * response left products out.
 */
function feedFileHeaders(file: FeedFilePagination | undefined, truncated: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (file) {
    headers["X-Scalius-Feed-File"] = `${file.number}/${file.total}`;
    if (file.overfullFiles.length > 0) headers["X-Scalius-Feed-Overfull"] = file.overfullFiles.join(",");
    if (file.checking) headers["X-Scalius-Feed-Checking"] = "1";
  }
  if (truncated) headers["X-Scalius-Feed-Truncated"] = "1";
  return headers;
}

export function createCatalogFeedGet(format: CatalogFeedFormat): APIRoute {
  const feedLabel =
    format === "meta" ? "Facebook product feed" : "Product catalog feed";

  return async ({ url }: APIContext) => {
    // The query is checked before any read: a refused request costs nothing.
    if (url.searchParams.has("page") || url.searchParams.has("cursor")) {
      return new Response(
        "Feed continuations are retired: each feed file is one complete URL. The dashboard (Online Store, Preferences) lists every file to register.",
        { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, no-store" } },
      );
    }
    const from = parseFeedFileFrom(url.searchParams.get(FEED_FILE_FROM_PARAM));
    if (from === null) {
      return new Response("Invalid from parameter", { status: 400 });
    }
    const requestedLimit = parsePositiveIntegerParam(url.searchParams.get("limit"), MAX_LIMIT, MAX_LIMIT);
    if (requestedLimit === null) {
      return new Response("Invalid limit parameter", { status: 400 });
    }
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
      // One request reads at most the plan's products, whatever `limit` asks:
      // a file holds no more product rows than that.
      const planCap = layoutData.platform?.feedProductsPerRequest;
      const limit = Math.min(
        requestedLimit,
        typeof planCap === "number" && Number.isSafeInteger(planCap) && planCap > 0 ? planCap : DEFAULT_FILE_PRODUCTS,
      );
      const currencyCode = layoutData.currency?.code ?? "BDT";
      // Feed prices are what checkout charges: at the store's increment.
      const priceIncrementMinor = resolvePriceIncrementMinor(currencyCode, layoutData.currency?.priceIncrementMinor);

      const feedFile = await readFeedFile({
        // Each feed lists what its own sales channel publishes.
        channel: format === "meta" ? META_CHANNEL_ID : GOOGLE_CHANNEL_ID,
        from,
        limit,
        baseUrl,
        currencyCode,
        priceIncrementMinor,
        feedsPolicy,
        feedVariantStrategy,
      });
      if (feedFile.status === "not_found") {
        return new Response("No feed file starts there. The dashboard (Online Store, Preferences) lists every feed file.", {
          status: 404,
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, no-store" },
        });
      }
      if (feedFile.status === "unavailable") {
        return xmlDataUnavailableResponse(
          `${feedLabel} is temporarily unavailable`,
        );
      }

      // A file holds more than one request lists only until the maintenance
      // splits it (or, for one second holding more, for good): never silently.
      const truncated = !feedFile.complete && !url.searchParams.has("limit");
      if (truncated) {
        console.warn(`${feedLabel} file from ${from} holds more than ${limit} products; the rest are listed once it is split.`);
      }
      const xml = generateCatalogFeed(
        feedFile.items,
        baseUrl,
        feedsPolicy,
        format,
        resolveStoreName(layoutData.business),
        // Each presence's feed states shipping to its market's countries, per item's shipping profile.
        { shippingMethods, currencyCode, countries: presenceMarketCountries(layoutData.markets, getRuntimePresence()) },
      );

      return new Response(xml, {
        status: 200,
        headers: { ...FEED_XML_HEADERS, ...feedFileHeaders(feedFile.file, truncated) },
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
