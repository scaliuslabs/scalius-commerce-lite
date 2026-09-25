// @vitest-environment node
// The product page's "Write a review": the personal answer comes from a
// same-origin no-store read, never from the shared page cache. The API
// resolves the order line; the page sends only the public product id, and a
// browser without a session never reaches the API.
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("@/lib/api/transport", () => ({
  resolveBackendTarget: (path: string) => ({ url: `https://api.internal${path}`, fetch: api.fetch, viaServiceBinding: true }),
}));

import { GET } from "../pages/api/reviews/[productId]/mine";
import { readProductReviewState } from "./account-reviews";
import { getPublicStorefrontCachePolicy } from "./public-worker-cache";
import { fetchProductReviewState } from "../components/product/reviews/review-cta";

const ORIGIN = "https://shop.example.test";
const SESSION = "cs_tok=session-token-value";
type RouteContext = Parameters<typeof GET>[0];

function get(productId: string, cookie?: string) {
  const request = new Request(`${ORIGIN}/api/reviews/${productId}/mine`, { headers: cookie ? { Cookie: cookie } : {} });
  return GET({ request, params: { productId } } as unknown as RouteContext);
}

const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const review = {
  id: "rev_1", orderId: "ord_1", orderItemId: "item_1", productId: "prod_1", productName: "Shirt", productSlug: "shirt",
  variantLabel: null, rating: 4, title: "Soft", body: null, displayName: "Rafi A.", status: "pending", reply: null,
  createdAt: "2026-09-26T00:00:00.000Z", publishedAt: null, editedAt: null, version: 1, canEdit: true,
};

beforeEach(() => api.fetch.mockReset());

describe("product page review call to action", () => {
  it("answers signed out without calling the API when the browser has no session", async () => {
    const response = await get("prod_1");
    expect(await response.json()).toEqual({ state: "signed_out" });
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("asks the API with the session cookie and the product id only; the API picks the order line", async () => {
    api.fetch.mockResolvedValueOnce(answer(200, { success: true, data: { state: "eligible", orderItemId: "item_1", displayName: "Rafi A." } }));
    const response = await get("prod_1", `${SESSION}; _ga=tracking`);
    expect(await response.json()).toEqual({ state: "eligible", orderItemId: "item_1", displayName: "Rafi A." });
    const [url, init] = api.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.internal/api/v1/customer-auth/reviews/products/prod_1");
    expect(new Headers(init.headers).get("Cookie")).toBe(SESSION);
  });

  it("is never stored by a shared cache: private no-store, varies on the cookie, outside the public page cache", async () => {
    api.fetch.mockResolvedValueOnce(answer(200, { success: true, data: { state: "reviewed", review } }));
    const signedIn = await get("prod_1", SESSION);
    const signedOut = await get("prod_1");
    for (const response of [signedIn, signedOut]) {
      expect(response.headers.get("Cache-Control")).toContain("no-store");
      expect(response.headers.get("Cache-Control")).toContain("private");
      expect(response.headers.get("Vary")).toContain("Cookie");
    }
    for (const cookie of [undefined, SESSION]) {
      const request = new Request(`${ORIGIN}/api/reviews/prod_1/mine`, { headers: cookie ? { Cookie: cookie } : {} });
      expect(getPublicStorefrontCachePolicy(request)).toBeNull();
    }
  });

  it("reads the answer in the browser same-origin and never from the HTTP cache", async () => {
    const fetcher = vi.fn(async () => answer(200, { state: "ineligible" }));
    await expect(fetchProductReviewState("prod_1", fetcher as unknown as typeof fetch)).resolves.toEqual({ state: "ineligible" });
    expect(fetcher).toHaveBeenCalledWith("/api/reviews/prod_1/mine", expect.objectContaining({ cache: "no-store", credentials: "same-origin" }));
    await expect(fetchProductReviewState("prod_1", (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).resolves.toEqual({ state: "unavailable" });
  });

  it("maps an expired session to signed out and anything malformed to unavailable (the plain link stays)", async () => {
    api.fetch.mockResolvedValueOnce(answer(401, { success: false }));
    expect(await (await get("prod_1", SESSION)).json()).toEqual({ state: "signed_out" });
    expect(readProductReviewState({ state: "eligible", orderItemId: "bad id!" })).toEqual({ state: "unavailable" });
    expect(readProductReviewState({ state: "reviewed", review: { id: "rev_1" } })).toEqual({ state: "unavailable" });
    expect(readProductReviewState({ state: "reviewed", review })).toMatchObject({ state: "reviewed", review: { status: "pending", canEdit: true } });
    expect(readProductReviewState(null)).toEqual({ state: "unavailable" });
  });
});
