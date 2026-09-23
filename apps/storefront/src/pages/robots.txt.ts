import type { APIRoute } from "astro";
import { getBaseUrl } from "@/lib/sitemap-utils";

export const prerender = false;

/**
 * Allow everything; advertise the one canonical sitemap only when the Store
 * URL is a valid absolute origin, so robots.txt never carries a relative line.
 */
export const GET: APIRoute = async () => {
  let robotsContent = "User-agent: *\nAllow: /";
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
