/** Published, indexable products; one bounded page per XML document, each later page at the boundary the index lists. */
import type { APIRoute } from "astro";
import { normalizeResourceCanonicalPath } from "@scalius/shared/seo-canonical";
import { paginatedSitemapResponse } from "@/lib/sitemap-utils";
import { getSitemapProducts } from "@/lib/api/products";

export const prerender = false;

export const GET: APIRoute = ({ url }) => paginatedSitemapResponse(
  url,
  getSitemapProducts,
  (row) => normalizeResourceCanonicalPath("product", row.canonicalPath) ?? `/products/${row.slug}`,
  "Product sitemap is temporarily unavailable",
  { boundaries: true },
);
