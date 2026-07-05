import type { APIRoute } from "astro";
import { env as cfEnv } from "cloudflare:workers";
import { getSeoSettings } from "@/lib/api";

export const prerender = false;

function ensureSitemapDirective(robotsContent: string, sitemapUrl: string): string {
  const sitemapLinePattern = /^sitemap:\s*(.*)$/gim;
  let replacedPlaceholder = false;

  const normalized = robotsContent.replace(sitemapLinePattern, (line, rawValue: string) => {
    const value = rawValue.trim();
    const isPlaceholder =
      value === "" ||
      value.startsWith("[") ||
      value.toLowerCase() === "your-sitemap-url" ||
      value.toLowerCase() === "[your-sitemap-url]";

    if (!isPlaceholder) {
      return line;
    }

    replacedPlaceholder = true;
    return `Sitemap: ${sitemapUrl}`;
  });

  if (replacedPlaceholder || normalized.toLowerCase().includes("sitemap:")) {
    return normalized;
  }

  return `${normalized}\n\nSitemap: ${sitemapUrl}`;
}

export const GET: APIRoute = async () => {
  const seoSettings = await getSeoSettings();

  if (!seoSettings) {
    return new Response("Robots policy is temporarily unavailable", {
      status: 503,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "private, no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
        "Retry-After": "30",
      },
    });
  }

  let robotsContent = "User-agent: *\nAllow: /"; // Default robots.txt

  if (seoSettings.robotsTxt) {
    robotsContent = seoSettings.robotsTxt;
  }

  // Append sitemap reference
  const env = cfEnv as unknown as Env;
  const storefrontUrl = (env?.STOREFRONT_URL as string) || '';
  const sitemapUrl = storefrontUrl
    ? `${storefrontUrl.replace(/\/$/, '')}/sitemap.xml`
    : '/sitemap.xml';

  robotsContent = ensureSitemapDirective(robotsContent, sitemapUrl);

  return new Response(robotsContent, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      // Cache for 1 hour, allow stale for 1 day
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    },
  });
};
