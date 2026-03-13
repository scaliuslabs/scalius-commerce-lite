/**
 * Facebook Product Feed Endpoint
 * Generates XML RSS 2.0 feed compatible with Facebook/Meta product catalog
 * Supports pagination for large product catalogs (?page=1&limit=1000)
 *
 * Feed format follows Meta's product data specifications:
 * https://www.facebook.com/business/help/120325381656392
 */

import type { APIRoute } from 'astro';
import { getAllProducts } from '@/lib/api/products';
import type { Product } from '@/lib/api/types';
import {
  getGoogleCategory,
  getFacebookCategory,
  escapeXmlCategory,
} from '@/lib/category-mapping';
import { getLayoutData } from '@/lib/api';

export const prerender = false;

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;

/**
 * Escapes XML special characters
 */
function escapeXml(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Formats price for Facebook feed (number + space + currency)
 */
function formatFeedPrice(price: number, currencyCode: string): string {
  return `${price.toFixed(2)} ${currencyCode}`;
}

/**
 * Determines product availability based on stock and active status
 */
function getAvailability(product: Product): 'in stock' | 'out of stock' {
  // If product is explicitly marked as inactive, it's out of stock
  // Treat undefined isActive as active (since API list endpoint doesn't return this field)
  if (product.isActive === false) {
    return 'out of stock';
  }

  // For products with variants, we'll mark as in stock if the product itself is active
  // Individual variant stock is handled by variants having their own availability
  return 'in stock';
}

/**
 * Generates a single product item for the feed
 */
function generateProductItem(product: Product, baseUrl: string, currencyCode: string): string {
  const productUrl = `${baseUrl}/products/${product.slug}`;
  const availability = getAvailability(product);

  // Get category mappings
  const categorySlug = product.category?.slug || '';
  const categoryName = product.category?.name || '';
  const googleCategory = escapeXmlCategory(getGoogleCategory(categorySlug));
  const facebookCategory = escapeXmlCategory(getFacebookCategory(categorySlug));

  // Build the item XML
  let item = '  <item>\n';

  // Required fields
  item += `    <g:id>${escapeXml(product.id)}</g:id>\n`;
  item += `    <g:title>${escapeXml(product.name)}</g:title>\n`;
  item += `    <g:description>${escapeXml(product.description || product.name)}</g:description>\n`;
  item += `    <g:link>${escapeXml(productUrl)}</g:link>\n`;
  item += `    <g:availability>${availability}</g:availability>\n`;
  item += `    <g:condition>new</g:condition>\n`;
  item += `    <g:price>${formatFeedPrice(product.discountedPrice || product.price, currencyCode)}</g:price>\n`;

  // Image (required)
  if (product.imageUrl) {
    item += `    <g:image_link>${escapeXml(product.imageUrl)}</g:image_link>\n`;
  }

  // Brand - try to get from attributes
  const brandAttribute = product.attributes?.find(
    (attr) => attr.name.toLowerCase() === 'brand'
  );
  const brand = brandAttribute?.value || 'Generic';
  item += `    <g:brand>${escapeXml(brand)}</g:brand>\n`;

  // Optional fields

  // Sale price if there's a discount
  if (product.discountedPrice && product.discountedPrice < product.price) {
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

      if (attrName === 'color' || attrName === 'colour') {
        item += `    <g:color>${escapeXml(attr.value)}</g:color>\n`;
      } else if (attrName === 'size') {
        item += `    <g:size>${escapeXml(attr.value)}</g:size>\n`;
      } else if (attrName === 'material') {
        item += `    <g:material>${escapeXml(attr.value)}</g:material>\n`;
      } else if (attrName === 'gender') {
        item += `    <g:gender>${escapeXml(attr.value)}</g:gender>\n`;
      } else if (attrName === 'age_group' || attrName === 'age group') {
        item += `    <g:age_group>${escapeXml(attr.value)}</g:age_group>\n`;
      } else if (attrName === 'pattern') {
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

  item += '  </item>\n';
  return item;
}

/**
 * Generates the complete Facebook product feed
 */
function generateFacebookFeed(products: Product[], baseUrl: string, currencyCode: string): string {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">\n';
  xml += '<channel>\n';
  xml += `<title>${escapeXml('Product Catalog')}</title>\n`;
  xml += `<link>${escapeXml(baseUrl)}</link>\n`;
  xml += `<description>${escapeXml('Complete product catalog for Facebook/Instagram shopping')}</description>\n`;

  for (const product of products) {
    xml += generateProductItem(product, baseUrl, currencyCode);
  }

  xml += '</channel>\n';
  xml += '</rss>';
  return xml;
}

import { getRuntimeStorefrontUrl } from "@/lib/runtime-env";
import type { APIContext } from 'astro';

export const GET: APIRoute = async ({ url, locals }: APIContext) => {
  try {
    const baseUrl = getRuntimeStorefrontUrl(locals);
    if (!baseUrl) {
      return new Response('STOREFRONT_URL not configured', { status: 500 });
    }

    // Get pagination parameters
    const pageParam = url.searchParams.get('page');
    const limitParam = url.searchParams.get('limit');

    const page = pageParam ? parseInt(pageParam, 10) : 1;
    const limit = limitParam
      ? Math.min(parseInt(limitParam, 10), MAX_LIMIT)
      : DEFAULT_LIMIT;

    if (isNaN(page) || page < 1) {
      return new Response('Invalid page parameter', { status: 400 });
    }

    if (isNaN(limit) || limit < 1) {
      return new Response('Invalid limit parameter', { status: 400 });
    }

    // Fetch layout data for currency settings
    const layoutData = await getLayoutData();
    const currencyCode = layoutData?.currency?.code ?? "BDT";

    // We need multiple API pages to fulfill 1 feed chunk depending on limit
    const limitParams = 100; // Fetch 100 products per API call
    const startApiPage = ((page - 1) * (limit / limitParams)) + 1;
    let requiredApiPages = limit / limitParams;

    const allProducts: Product[] = [];

    // Fetch first page to get totalPages
    const firstResponse = await getAllProducts({
      page: startApiPage,
      limit: limitParams,
    });

    if (!firstResponse || !firstResponse.data || firstResponse.data.length === 0) {
      if (page > 1) {
        return new Response('Page not found', { status: 404 });
      }
      return new Response(generateFacebookFeed([], baseUrl, currencyCode), {
        status: 200,
        headers: { 'Content-Type': 'application/xml; charset=utf-8' }
      });
    }

    allProducts.push(...firstResponse.data.filter((p) => p.isActive !== false));
    const totalPages = firstResponse.pagination.totalPages;

    // Limit requiredApiPages if we hit the end of the total products early
    const maxApiPage = Math.min(startApiPage + requiredApiPages - 1, totalPages);

    // Fetch remaining API pages needed for this feed chunk in parallel batches to avoid timeout
    const BATCH_SIZE = 5;
    for (let currentApiPage = startApiPage + 1; currentApiPage <= maxApiPage; currentApiPage += BATCH_SIZE) {
      const fetchPromises = [];
      const endBatchPage = Math.min(currentApiPage + BATCH_SIZE - 1, maxApiPage);

      for (let p = currentApiPage; p <= endBatchPage; p++) {
        fetchPromises.push(getAllProducts({ page: p, limit: limitParams }));
      }

      const batchResponses = await Promise.all(fetchPromises);
      for (const res of batchResponses) {
        if (res && res.data) {
          allProducts.push(...res.data.filter((p) => p.isActive !== false));
        }
      }
    }

    if (allProducts.length === 0 && page > 1) {
      return new Response('Page not found', { status: 404 });
    }

    // Generate feed XML
    const xml = generateFacebookFeed(allProducts, baseUrl, currencyCode);

    return new Response(xml, {
      status: 200,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=43200',
      },
    });
  } catch (error) {
    console.error('Error generating Facebook product feed:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
};
