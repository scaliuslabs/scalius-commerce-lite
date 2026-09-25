// review_request send-time content: the link is the account order page or the
// guest order lookup on the Store URL, never a token; nothing to send when
// the recheck finds nothing; no Store URL retries instead of a relative link.
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ reviewRequestSendCheck: vi.fn() }));
vi.mock("@scalius/core/modules/reviews", () => ({ reviewRequestSendCheck: mocks.reviewRequestSendCheck }));

import { resolveReviewRequestContent, reviewProductsPhrase } from "./review-request";

const db = {} as never;
const env = (storefrontUrl?: string) => ({ STOREFRONT_URL: storefrontUrl }) as unknown as Env;
const input = { orderId: "ord_1057", data: { orderId: "ord_1057" } };

describe("review request content", () => {
  afterEach(() => vi.clearAllMocks());

  it("links an account's order page and a guest's order lookup, with no token", async () => {
    mocks.reviewRequestSendCheck.mockResolvedValueOnce({ productNames: ["Linen Shirt"], accountOwned: true });
    expect(await resolveReviewRequestContent(db, env("https://shop.example.com/"), input)).toEqual({
      review_products: "Linen Shirt",
      review_link: "https://shop.example.com/account/orders/ord_1057#reviews",
    });
    mocks.reviewRequestSendCheck.mockResolvedValueOnce({ productNames: ["Linen Shirt", "Clay Mug"], accountOwned: false });
    expect(await resolveReviewRequestContent(db, env("https://shop.example.com"), input)).toEqual({
      review_products: "Linen Shirt, Clay Mug",
      review_link: "https://shop.example.com/track-order",
    });
  });

  it("sends nothing when the recheck finds nothing, and retries without a Store URL", async () => {
    mocks.reviewRequestSendCheck.mockResolvedValueOnce(null);
    expect(await resolveReviewRequestContent(db, env("https://shop.example.com"), input)).toBeNull();
    mocks.reviewRequestSendCheck.mockResolvedValueOnce({ productNames: ["Linen Shirt"], accountOwned: true });
    await expect(resolveReviewRequestContent(db, env(undefined), input)).rejects.toThrow(/Store URL/);
    mocks.reviewRequestSendCheck.mockResolvedValueOnce({ productNames: ["Linen Shirt"], accountOwned: true });
    await expect(resolveReviewRequestContent(db, env("javascript:alert(1)"), input)).rejects.toThrow(/Store URL/);
  });

  it("names at most three products, language-neutral", () => {
    expect(reviewProductsPhrase(["A", "B", "C", "D"])).toBe("A, B, C…");
    expect(reviewProductsPhrase(["শার্ট"])).toBe("শার্ট");
  });
});
