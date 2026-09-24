import type { APIRoute } from "astro";
import { getBaseUrl } from "@/lib/sitemap-utils";

export const prerender = false;

/**
 * Private buyer pages, internal search results and sort/filter variants are
 * noindexed already; keep crawlers from spending the crawl budget on them
 * (the same set Shopify disallows). Paginated listings stay crawlable.
 */
const DISALLOWED_PATHS = [
  "/cart$",
  "/checkout$",
  "/checkout/",
  "/account$",
  "/account/",
  "/order-success",
  "/payment-recovery",
  "/theme-preview",
  "/agent/",
  "/search",
  "/*?*sortBy=",
  "/*?*minPrice=",
  "/*?*maxPrice=",
  "/*?*hasDiscount=",
  "/*?*freeDelivery=",
] as const;

const ROBOTS_RULES = [
  "User-agent: *",
  ...DISALLOWED_PATHS.map((path) => `Disallow: ${path}`),
  "Allow: /",
].join("\n");

/**
 * Advertise the one canonical sitemap only when the Store URL is a valid
 * absolute origin, so robots.txt never carries a relative line.
 */
export const GET: APIRoute = async () => {
  let robotsContent = ROBOTS_RULES;
  try {
    robotsContent += `\n\nSitemap: ${getBaseUrl()}/sitemap.xml`;
  } catch {
    // Store URL missing or not an absolute origin: no Sitemap line.
  }

  return new Response(robotsContent, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      // Cache for 1 hour, allow stale for 1 day
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    },
  });
};
