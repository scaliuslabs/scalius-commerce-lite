import type { APIRoute } from "astro";
import { getSeoSettings } from "@/lib/api";

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  const seoSettings = await getSeoSettings();

  let robotsContent = "User-agent: *\nAllow: /"; // Default robots.txt

  if (seoSettings && seoSettings.robotsTxt) {
    robotsContent = seoSettings.robotsTxt;
  }

  // Append sitemap reference
  const storefrontUrl = (locals.runtime?.env?.STOREFRONT_URL as string) || import.meta.env.STOREFRONT_URL || '';
  const sitemapUrl = storefrontUrl
    ? `${storefrontUrl.replace(/\/$/, '')}/sitemap.xml`
    : '/sitemap.xml';

  // Add sitemap if not already present
  if (!robotsContent.toLowerCase().includes('sitemap:')) {
    robotsContent += `\n\nSitemap: ${sitemapUrl}`;
  }

  return new Response(robotsContent, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      // Cache for 1 hour, allow stale for 1 day
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    },
  });
};
