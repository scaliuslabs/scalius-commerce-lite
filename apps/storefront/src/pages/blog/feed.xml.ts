import type { APIRoute } from "astro";
import { getArticles } from "@/lib/api/articles";
import { getLayoutData } from "@/lib/api";
import { getBaseUrl, xmlDataUnavailableResponse } from "@/lib/sitemap-utils";
import { htmlToPlainText } from "@scalius/shared/html-sanitize";
import { normalizeResourceCanonicalPath } from "@scalius/shared/seo-canonical";

export const prerender = false;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function rssDate(value: number | null): string | null {
  if (!value) return null;
  const date = new Date(value < 1_000_000_000_000 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? null : date.toUTCString();
}

export const GET: APIRoute = async () => {
  try {
    const baseUrl = getBaseUrl();
    const [layoutData, result] = await Promise.all([
      getLayoutData(),
      getArticles({ page: 1, limit: 24 }),
    ]);
    if (!layoutData || !result)
      return xmlDataUnavailableResponse("Blog feed is temporarily unavailable");
    const storeName =
      layoutData.business?.companyName?.trim() ||
      layoutData.business?.legalName?.trim() ||
      "Store";
    const items = result.data
      .map((article) => {
        const path =
          normalizeResourceCanonicalPath("article", article.canonicalPath) ??
          `/blog/${article.slug}`;
        const link = `${baseUrl}${path}`;
        const description =
          article.excerpt || htmlToPlainText(article.content).slice(0, 500);
        const published = rssDate(article.publishedAt);
        return [
          "    <item>",
          `      <title>${escapeXml(article.title)}</title>`,
          `      <link>${escapeXml(link)}</link>`,
          `      <guid isPermaLink="true">${escapeXml(link)}</guid>`,
          description
            ? `      <description>${escapeXml(description)}</description>`
            : "",
          published ? `      <pubDate>${published}</pubDate>` : "",
          ...article.tags.map(
            (tag) => `      <category>${escapeXml(tag)}</category>`,
          ),
          "    </item>",
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n");
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
      "  <channel>",
      `    <title>${escapeXml(`${storeName} Blog`)}</title>`,
      `    <link>${escapeXml(`${baseUrl}/blog`)}</link>`,
      `    <description>${escapeXml(`Stories, guides, and updates from ${storeName}.`)}</description>`,
      `    <atom:link href="${escapeXml(`${baseUrl}/blog/feed.xml`)}" rel="self" type="application/rss+xml" />`,
      items,
      "  </channel>",
      "</rss>",
    ].join("\n");
    return new Response(xml, {
      headers: {
        "Content-Type": "application/rss+xml; charset=utf-8",
        "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      },
    });
  } catch (error: unknown) {
    console.error("Error generating blog feed:", error);
    return xmlDataUnavailableResponse("Blog feed is temporarily unavailable");
  }
};
