// "Show more" on the product page (Wave B §2.4): one page of the product's
// published reviews through the storefront origin, the same data the review
// page renders. Query: sort (recent, highest, lowest), rating (1-5), cursor
// and limit (up to 20). Public and cached under the store's generation like
// the page; 404 when the product is not public or reviews are off.
import type { APIRoute } from "astro";
import { getProductReviewsPage } from "@/lib/api/product-reviews";
import { REVIEW_PAGE_SIZE, readReviewListView } from "@/components/product/reviews/review-format";

export const prerender = false;

const json = (status: number, body: unknown, cacheControl: string) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
    },
  });

export const GET: APIRoute = async ({ params, url }) => {
  const productId = params.productId ?? "";
  const view = readReviewListView(url.searchParams);
  const cursor = url.searchParams.get("cursor");
  const limit = Number(url.searchParams.get("limit") ?? REVIEW_PAGE_SIZE);
  const result = await getProductReviewsPage(productId, {
    sort: view.sort,
    rating: view.rating,
    cursor: cursor && /^[A-Za-z0-9+/_-]{1,200}$/.test(cursor) ? cursor : null,
    limit: Number.isFinite(limit) ? limit : REVIEW_PAGE_SIZE,
  });
  if (result.state === "not_found") {
    return json(404, { success: false, error: { code: "NOT_FOUND", message: "Reviews not found" } }, "public, max-age=0, no-cache, must-revalidate");
  }
  if (result.state === "unavailable") {
    return json(503, { success: false, error: { code: "UNAVAILABLE", message: "Reviews are unavailable right now" } }, "private, no-store");
  }
  // Browsers revalidate; the shared cache keeps it under the store's generation.
  return json(200, { success: true, data: result.data }, "public, max-age=0, no-cache, must-revalidate");
};
