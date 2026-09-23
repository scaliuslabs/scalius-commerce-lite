import type { APIRoute } from "astro";
import { getArticles } from "@/lib/api/articles";
import {
  generateSitemap,
  getBaseUrl,
  getSitemapHeaders,
  xmlDataUnavailableResponse,
  type SitemapUrl,
} from "@/lib/sitemap-utils";
import { normalizeResourceCanonicalPath } from "@scalius/shared/seo-canonical";

export const prerender = false;

export const GET: APIRoute = async () => {
  try {
    const baseUrl = getBaseUrl();

    const urls: SitemapUrl[] = [];
    let page = 1;
    while (true) {
      const result = await getArticles({ page, limit: 24 });
      if (!result)
        return xmlDataUnavailableResponse(
          "Articles sitemap is temporarily unavailable",
        );
      for (const article of result.data) {
        if (!article.noIndex && !article.excludeFromSitemap) {
          const path =
            normalizeResourceCanonicalPath("article", article.canonicalPath) ??
            `/blog/${article.slug}`;
          urls.push({
            loc: `${baseUrl}${path}`,
            lastmod: article.updatedAt || article.publishedAt || undefined,
          });
        }
      }
      if (page >= result.pagination.totalPages) break;
      page += 1;
    }

    return new Response(generateSitemap(urls, baseUrl), {
      headers: getSitemapHeaders(),
    });
  } catch (error: unknown) {
    console.error("Error generating articles sitemap:", error);
    return xmlDataUnavailableResponse(
      "Articles sitemap is temporarily unavailable",
    );
  }
};
