import type { APIRoute } from "astro";
import { getSeoSettings } from "@/lib/api";
import { getBaseUrl, xmlDataUnavailableResponse } from "@/lib/sitemap-utils";
import { normalizeSeoDiscoverySettings } from "@scalius/shared/seo-discovery";

export const prerender = false;

function isPlaceholderSitemapValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "" ||
    normalized === "your-sitemap-url" ||
    normalized === "[your-sitemap-url]" ||
    (normalized.startsWith("[") && normalized.endsWith("]"))
  );
}

function isCanonicalSitemapUrl(value: string, sitemapUrl: string): boolean {
  try {
    return new URL(value).href === new URL(sitemapUrl).href;
  } catch {
    return false;
  }
}

function normalizeSitemapDirectives(
  robotsContent: string,
  { advertise, sitemapUrl }: { advertise: boolean; sitemapUrl?: string },
): string {
  let canonicalSitemapEmitted = false;
  const lines: string[] = [];

  for (const line of robotsContent.split(/\r?\n/)) {
    const match = line.match(/^sitemap:\s*(.*)$/i);
    if (!match) {
      lines.push(line);
      continue;
    }

    const value = match[1]?.trim() ?? "";
    const isPlaceholder = isPlaceholderSitemapValue(value);
    const isCanonicalSitemap =
      sitemapUrl !== undefined && isCanonicalSitemapUrl(value, sitemapUrl);

    if (advertise && sitemapUrl && (isPlaceholder || !isCanonicalSitemap)) {
      if (!canonicalSitemapEmitted) {
        lines.push(`Sitemap: ${sitemapUrl}`);
        canonicalSitemapEmitted = true;
      }
      continue;
    }

    if (!isCanonicalSitemap) {
      continue;
    }

    if (advertise && sitemapUrl && !canonicalSitemapEmitted) {
      lines.push(`Sitemap: ${sitemapUrl}`);
      canonicalSitemapEmitted = true;
    }
  }

  if (advertise && sitemapUrl && !canonicalSitemapEmitted) {
    const needsSpacer = lines.some((line) => line.trim() !== "");
    if (needsSpacer) lines.push("");
    lines.push(`Sitemap: ${sitemapUrl}`);
  }

  return lines.join("\n").trim();
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

  const discovery = normalizeSeoDiscoverySettings(seoSettings.discovery);
  if (discovery.sitemap.enabled && discovery.robots.advertiseSitemap) {
    let sitemapUrl: string;
    try {
      sitemapUrl = `${getBaseUrl()}/sitemap.xml`;
    } catch {
      return xmlDataUnavailableResponse("Robots policy is temporarily unavailable");
    }

    robotsContent = normalizeSitemapDirectives(robotsContent, {
      advertise: true,
      sitemapUrl,
    });
  } else {
    robotsContent = normalizeSitemapDirectives(robotsContent, {
      advertise: false,
    });
  }

  return new Response(robotsContent, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      // Cache for 1 hour, allow stale for 1 day
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    },
  });
};
