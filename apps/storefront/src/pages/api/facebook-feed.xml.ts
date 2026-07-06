/**
 * Facebook Product Feed Endpoint
 * Generates XML RSS 2.0 feed compatible with Facebook/Meta product catalog
 * Supports pagination for large product catalogs (?page=1&limit=1000)
 *
 * Feed format follows Meta's product data specifications:
 * https://www.facebook.com/business/help/120325381656392
 */

import type { APIRoute, APIContext } from "astro";
import { getAllProducts } from "@/lib/api/products";
import type { Product } from "@/lib/api/types";
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

export const prerender = false;

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;
const FEED_IMAGE_OPTIONS = {
  width: 1200,
  quality: 90,
  format: "auto",
  fit: "scale-down",
} as const;

type FeedProduct = {
  product: Product;
  imageLink: string;
};

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
function getAvailability(product: Product): "in stock" | "out of stock" {
  if (product.isActive === false) {
    return "out of stock";
  }

  return product.availableForSale === false ? "out of stock" : "in stock";
}

function getPrimaryImageLink(product: Product, baseUrl: string): string | null {
  const sourceImage = product.imageUrl?.trim();
  if (!sourceImage) {
    return null;
  }

  const imageLink = getOptimizedImageUrl(sourceImage, FEED_IMAGE_OPTIONS).trim();
  if (!imageLink) {
    return null;
  }

  try {
    const parsed = new URL(imageLink, baseUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

function toFeedProduct(product: Product, baseUrl: string): FeedProduct | null {
  if (product.isActive === false) {
    return null;
  }

  const imageLink = getPrimaryImageLink(product, baseUrl);
  if (!imageLink) {
    return null;
  }

  return { product, imageLink };
}

function toFeedProducts(
  products: Product[],
  baseUrl: string,
  feedsPolicy: SeoDiscoverySettings["feeds"],
): FeedProduct[] {
  return products.flatMap((product) => {
    if (
      !feedsPolicy.includeUnavailableProducts &&
      getAvailability(product) !== "in stock"
    ) {
      return [];
    }

    const feedProduct = toFeedProduct(product, baseUrl);
    return feedProduct ? [feedProduct] : [];
  });
}

/**
 * Generates a single product item for the feed
 */
function generateProductItem(
  feedProduct: FeedProduct,
  baseUrl: string,
  currencyCode: string,
): string {
  const { product, imageLink } = feedProduct;
  const productUrl = `${baseUrl}/products/${product.slug}`;
  const availability = getAvailability(product);
  const feedPrice = product.discountedPrice ?? product.price;

  // Get category mappings
  const categorySlug = product.category?.slug || "";
  const categoryName = product.category?.name || "";
  const googleCategory = escapeXmlCategory(getGoogleCategory(categorySlug));
  const facebookCategory = escapeXmlCategory(getFacebookCategory(categorySlug));

  // Build the item XML
  let item = "  <item>\n";

  // Required fields
  item += `    <g:id>${escapeXml(product.id)}</g:id>\n`;
  item += `    <g:title>${escapeXml(product.name)}</g:title>\n`;
  item += `    <g:description>${escapeXml(product.description || product.name)}</g:description>\n`;
  item += `    <g:link>${escapeXml(productUrl)}</g:link>\n`;
  item += `    <g:availability>${availability}</g:availability>\n`;
  item += `    <g:condition>new</g:condition>\n`;
  item += `    <g:price>${formatFeedPrice(feedPrice, currencyCode)}</g:price>\n`;

  // Image (required)
  item += `    <g:image_link>${escapeXml(imageLink)}</g:image_link>\n`;

  // Brand - try to get from attributes
  const brandAttribute = product.attributes?.find(
    (attr) => attr.name.toLowerCase() === "brand",
  );
  const brand = brandAttribute?.value || "Generic";
  item += `    <g:brand>${escapeXml(brand)}</g:brand>\n`;

  // Optional fields

  // Sale price if there's a discount
  if (product.discountedPrice != null && product.discountedPrice < product.price) {
    item += `    <g:sale_price>${formatFeedPrice(product.discountedPrice, currencyCode)}</g:sale_price>\n`;
  }

  // Item group ID for variants
  if (product.hasVariants) {
    item += `    <g:item_group_id>${escapeXml(product.id)}</g:item_group_id>\n`;
  }

  // Categories
  item += `    <g:google_product_category>${googleCategory}</g:google_product_category>\n`;
  item += `    <g:fb_product_category>${facebookCategory}</g:fb_product_category>\n`;
  item += `    <g:product_type>${escapeXml(categoryName)}</g:product_type>\n`;

  // Additional attributes
  if (product.attributes && product.attributes.length > 0) {
    product.attributes.forEach((attr) => {
      const attrName = attr.name.toLowerCase();

      if (attrName === "color" || attrName === "colour") {
        item += `    <g:color>${escapeXml(attr.value)}</g:color>\n`;
      } else if (attrName === "size") {
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
 * Generates the complete Facebook product feed
 */
function generateFacebookFeed(
  products: FeedProduct[],
  baseUrl: string,
  currencyCode: string,
  feedsPolicy: SeoDiscoverySettings["feeds"],
): string {
  const title = feedsPolicy.title || "Product Catalog";
  const description =
    feedsPolicy.description ||
    "Complete product catalog for Facebook/Instagram shopping";

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">\n';
  xml += "<channel>\n";
  xml += `<title>${escapeXml(title)}</title>\n`;
  xml += `<link>${escapeXml(baseUrl)}</link>\n`;
  xml += `<description>${escapeXml(description)}</description>\n`;

  for (const product of products) {
    xml += generateProductItem(product, baseUrl, currencyCode);
  }

  xml += "</channel>\n";
  xml += "</rss>";
  return xml;
}

export const GET: APIRoute = async ({ url }: APIContext) => {
  try {
    let baseUrl: string;
    try {
      baseUrl = getBaseUrl();
    } catch (error) {
      console.error("Facebook product feed base URL is not configured:", error);
      return xmlDataUnavailableResponse("Facebook product feed is temporarily unavailable");
    }
    const seo = await getSeoSettings();
    if (!seo) {
      return xmlDataUnavailableResponse("Facebook product feed is temporarily unavailable");
    }
    const feedsPolicy = normalizeSeoDiscoverySettings(seo.discovery).feeds;
    if (!feedsPolicy.productCatalogEnabled) {
      return new Response("Product catalog feed is disabled", {
        status: 404,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "private, no-cache, no-store, must-revalidate",
        },
      });
    }

    // Get pagination parameters
    const pageParam = url.searchParams.get("page");
    const limitParam = url.searchParams.get("limit");

    const page = pageParam ? parseInt(pageParam, 10) : 1;
    const limit = limitParam
      ? Math.min(parseInt(limitParam, 10), MAX_LIMIT)
      : DEFAULT_LIMIT;

    if (isNaN(page) || page < 1) {
      return new Response("Invalid page parameter", { status: 400 });
    }

    if (isNaN(limit) || limit < 1) {
      return new Response("Invalid limit parameter", { status: 400 });
    }

    // Fetch layout data for currency settings
    const layoutData = await getLayoutData();
    setRuntimeImageCdnPolicy(layoutData?.media);
    const currencyCode = layoutData?.currency?.code ?? "BDT";

    // We need multiple API pages to fulfill 1 feed chunk depending on limit
    const limitParams = 100; // Fetch 100 products per API call
    const requiredApiPages = Math.ceil(limit / limitParams);
    const startApiPage = (page - 1) * requiredApiPages + 1;

    const allProducts: FeedProduct[] = [];

    // Fetch first page to get totalPages
    const firstResponse = await getAllProducts({
      page: startApiPage,
      limit: limitParams,
    });

    if (!firstResponse) {
      return xmlDataUnavailableResponse("Facebook product feed is temporarily unavailable");
    }

    if (!firstResponse.data || firstResponse.data.length === 0) {
      if (page > 1) {
        return new Response("Page not found", { status: 404 });
      }
      return new Response(generateFacebookFeed([], baseUrl, currencyCode, feedsPolicy), {
        status: 200,
        headers: { "Content-Type": "application/xml; charset=utf-8" },
      });
    }

    allProducts.push(...toFeedProducts(firstResponse.data, baseUrl, feedsPolicy));
    const totalPages = firstResponse.pagination.totalPages;

    // Limit requiredApiPages if we hit the end of the total products early
    const maxApiPage = Math.min(
      startApiPage + requiredApiPages - 1,
      totalPages,
    );

    // Fetch remaining API pages needed for this feed chunk in parallel batches to avoid timeout
    const BATCH_SIZE = 5;
    for (
      let currentApiPage = startApiPage + 1;
      currentApiPage <= maxApiPage;
      currentApiPage += BATCH_SIZE
    ) {
      const fetchPromises = [];
      const endBatchPage = Math.min(
        currentApiPage + BATCH_SIZE - 1,
        maxApiPage,
      );

      for (let p = currentApiPage; p <= endBatchPage; p++) {
        fetchPromises.push(getAllProducts({ page: p, limit: limitParams }));
      }

      const batchResponses = await Promise.all(fetchPromises);
      for (const res of batchResponses) {
        if (!res) {
          return xmlDataUnavailableResponse("Facebook product feed is temporarily unavailable");
        }
        if (res && res.data) {
          allProducts.push(...toFeedProducts(res.data, baseUrl, feedsPolicy));
        }
      }
    }

    if (allProducts.length === 0 && page > 1) {
      return new Response("Page not found", { status: 404 });
    }

    // Generate feed XML
    const xml = generateFacebookFeed(
      allProducts.slice(0, limit),
      baseUrl,
      currencyCode,
      feedsPolicy,
    );

    return new Response(xml, {
      status: 200,
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "public, max-age=3600, stale-while-revalidate=43200",
      },
    });
  } catch (error: unknown) {
    console.error("Error generating Facebook product feed:", error);
    return xmlDataUnavailableResponse("Facebook product feed is temporarily unavailable");
  }
};
