/** Public blog articles; one bounded page of up to 5,000 URLs per XML document, every page listed by the index. */
import type { APIRoute } from "astro";
import { normalizeResourceCanonicalPath } from "@scalius/shared/seo-canonical";
import { paginatedSitemapResponse } from "@/lib/sitemap-utils";
import { getSitemapContent } from "@/lib/api/content-sitemap";

export const prerender = false;

export const GET: APIRoute = ({ url }) => paginatedSitemapResponse(
  url,
  async (options) => {
    const response = await getSitemapContent("articles", options);
    // An article's lastmod is its last change, else its publication.
    return response && { data: response.data.map((row) => ({ ...row, updatedAt: row.updatedAt ?? row.publishedAt })) };
  },
  (row) => normalizeResourceCanonicalPath("article", row.canonicalPath) ?? `/blog/${row.slug}`,
  "Articles sitemap is temporarily unavailable",
);
