// The product page's review call to action, read after hydration: may this
// browser's account write a review of this product, or edit its own? The
// product page HTML is shared and publicly cached, so this personal answer
// comes from here instead: same-origin, the session cookie only, the public
// product id the only thing in the URL, and never stored by any cache.
import type { APIRoute } from "astro";
import { isReviewId } from "@/lib/account-reviews";
import { privateJson, readProductReviewStateForRequest } from "@/lib/account-reviews-server";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const productId = params.productId;
  const state = isReviewId(productId)
    ? await readProductReviewStateForRequest(request, productId)
    : { state: "unavailable" as const };
  const response = privateJson(isReviewId(productId) ? 200 : 400, state);
  response.headers.set("Vary", "Cookie");
  return response;
};
