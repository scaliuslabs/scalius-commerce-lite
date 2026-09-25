// @vitest-environment node
// The review form's POST without JavaScript (a 303 back with only a flag, the
// line id and its anchor) and with it (JSON, so the typed text survives an
// error). The receipt proof goes to the API as a header only; review text
// goes in the API body only, never a URL.
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("@/lib/api/transport", () => ({
  resolveBackendTarget: (path: string) => ({
    url: `https://api.internal${path}`,
    fetch: api.fetch,
    viaServiceBinding: true,
  }),
}));

vi.mock("@/lib/api", () => ({
  getActiveCheckoutLanguage: async () => null,
  getLayoutData: async () => ({ storefrontCopy: { languageCode: "bn" } }),
}));

import { readBuyerReviewsForRequest } from "./account-reviews-server";
import { getOrderReceiptCookieName } from "./order-receipt-cookie";
import { POST } from "../pages/api/reviews/submit";

const ORIGIN = "https://shop.example.test";
const PROOF = `chk_${"p".repeat(40)}`;
const SESSION = "cs_tok=session-token-value";
const RECEIPT_COOKIE = `${getOrderReceiptCookieName("ord_1")}=${PROOF}`;
const SECRET_TEXT = "My private review text";

type RouteContext = Parameters<typeof POST>[0];

function post(fields: Record<string, string>, init: { cookie?: string; json?: boolean; origin?: string } = {}) {
  const headers: Record<string, string> = {
    Origin: init.origin ?? ORIGIN,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (init.cookie) headers.Cookie = init.cookie;
  if (init.json) headers.Accept = "application/json";
  const request = new Request(`${ORIGIN}/api/reviews/submit`, { method: "POST", headers, body: new URLSearchParams(fields) });
  return POST({ request } as unknown as RouteContext);
}

function apiAnswer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function calls() {
  return api.fetch.mock.calls.map(([url, init]) => ({
    url: String(url),
    method: (init as RequestInit).method,
    headers: new Headers((init as RequestInit).headers),
    body: JSON.parse(String((init as RequestInit).body ?? "null")),
  }));
}

const submitFields = {
  intent: "submit",
  orderItemId: "item_1",
  rating: "5",
  title: "Great",
  body: SECRET_TEXT,
  displayName: "",
  clientKey: "key-12345678",
  returnTo: "/order-success?orderId=ord_1",
};

beforeEach(() => {
  api.fetch.mockReset();
});

describe("POST /api/reviews/submit without JavaScript", () => {
  it("submits a guest review with the receipt proof as a header and returns to the line", async () => {
    api.fetch.mockResolvedValue(apiAnswer(201, { success: true, data: { review: {}, created: true, published: true } }));
    const response = await post({ ...submitFields, orderId: "ord_1" }, { cookie: RECEIPT_COOKIE });
    expect(response.status).toBe(303);
    const location = response.headers.get("Location")!;
    expect(location).toBe("/order-success?orderId=ord_1&review=published&reviewLine=item_1#review-item_1");
    expect(location).not.toContain(PROOF);
    expect(location).not.toContain("private");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const [call] = calls();
    expect(call.url).toBe("https://api.internal/api/v1/orders/receipt/ord_1/reviews");
    expect(call.url).not.toContain(PROOF);
    expect(call.method).toBe("POST");
    expect(call.headers.get("X-Receipt-Token")).toBe(PROOF);
    expect(call.headers.get("Cookie")).toBeNull();
    expect(call.body).toEqual({ orderItemId: "item_1", rating: 5, title: "Great", body: SECRET_TEXT, displayName: null, clientKey: "key-12345678" });
  });

  it("submits a signed-in review with the session cookie only", async () => {
    api.fetch.mockResolvedValue(apiAnswer(201, { success: true, data: { published: false } }));
    const response = await post({ ...submitFields, returnTo: "/account/orders/ord_1" }, { cookie: `${SESSION}; other=1; ${RECEIPT_COOKIE}` });
    expect(response.headers.get("Location")).toBe("/account/orders/ord_1?review=pending&reviewLine=item_1#review-item_1");
    const [call] = calls();
    expect(call.url).toBe("https://api.internal/api/v1/customer-auth/reviews");
    expect(call.headers.get("Cookie")).toBe(SESSION);
    expect(call.headers.get("X-Receipt-Token")).toBeNull();
  });

  it("names the review to edit when the product was already reviewed", async () => {
    api.fetch.mockResolvedValue(apiAnswer(409, { success: false, error: { code: "REVIEW_EXISTS", message: "x", details: { reviewId: "rev_9" } } }));
    const response = await post({ ...submitFields, returnTo: "/account/reviews" }, { cookie: SESSION });
    expect(response.headers.get("Location")).toBe("/account/reviews?review=exists&reviewLine=item_1&reviewRef=rev_9#review-item_1");
  });

  it("asks for a star rating before calling the API", async () => {
    const response = await post({ ...submitFields, rating: "" }, { cookie: SESSION });
    expect(response.headers.get("Location")).toContain("review=rating");
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("sends a guest without the receipt cookie back to track the order", async () => {
    const response = await post({ ...submitFields, orderId: "ord_1" });
    expect(response.headers.get("Location")).toContain("review=receipt");
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("edits and withdraws with the review's version", async () => {
    api.fetch.mockResolvedValue(apiAnswer(200, { success: true, data: { published: true } }));
    await post({ intent: "edit", reviewId: "rev_1", version: "3", orderItemId: "item_1", rating: "4", title: "", body: "", displayName: "", returnTo: "/account/reviews" }, { cookie: SESSION });
    await post({ intent: "withdraw", reviewId: "rev_1", version: "4", orderItemId: "item_1", returnTo: "/account/reviews" }, { cookie: SESSION });
    const [edit, withdraw] = calls();
    expect(edit).toMatchObject({ url: "https://api.internal/api/v1/customer-auth/reviews/rev_1", method: "PATCH", body: { version: 3, rating: 4, title: null, body: null, displayName: null } });
    expect(withdraw).toMatchObject({ method: "PATCH", body: { version: 4, withdraw: true } });
  });

  it("never returns to another site, and refuses a cross-origin post", async () => {
    api.fetch.mockResolvedValue(apiAnswer(201, { success: true, data: { published: true } }));
    const away = await post({ ...submitFields, returnTo: "https://evil.test/account/reviews" }, { cookie: SESSION });
    expect(away.headers.get("Location")).toMatch(/^\/account\/reviews\?review=published/);
    const cross = await post(submitFields, { cookie: SESSION, origin: "https://evil.test" });
    expect(cross.status).toBe(403);
  });

  it("fails closed when the API is unreachable", async () => {
    api.fetch.mockRejectedValue(new Error("down"));
    const response = await post(submitFields, { cookie: SESSION });
    expect(response.headers.get("Location")).toContain("review=unavailable");
  });
});

describe("POST /api/reviews/submit with JavaScript", () => {
  it("answers JSON with the kind message in the page's language, keeping the form", async () => {
    api.fetch.mockResolvedValue(apiAnswer(429, { success: false, error: { code: "RATE_LIMITED", message: "slow" } }));
    const response = await post(submitFields, { cookie: SESSION, json: true });
    expect(response.headers.get("Content-Type")).toContain("application/json");
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, flag: "rate_limited" });
    expect(body.message).toContain("অপেক্ষা");
    expect(JSON.stringify(body)).not.toContain(SECRET_TEXT);
  });

  it("answers where to go on success", async () => {
    api.fetch.mockResolvedValue(apiAnswer(201, { success: true, data: { published: true } }));
    const body = await (await post(submitFields, { cookie: SESSION, json: true })).json() as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, flag: "published", location: "/order-success?orderId=ord_1&review=published&reviewLine=item_1#review-item_1" });
  });
});

describe("reading the buyer's reviews", () => {
  it("is signed out without a session and never calls the API", async () => {
    const result = await readBuyerReviewsForRequest(new Request(`${ORIGIN}/account/reviews`), { kind: "account" });
    expect(result).toEqual({ ok: false, reason: "signed_out" });
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("reads a receipt's reviews with the proof header", async () => {
    api.fetch.mockResolvedValue(apiAnswer(200, { success: true, data: { toReview: [], reviews: [] } }));
    const result = await readBuyerReviewsForRequest(new Request(`${ORIGIN}/order-success?orderId=ord_1`, { headers: { Cookie: RECEIPT_COOKIE } }), { kind: "receipt", orderId: "ord_1" });
    expect(result).toEqual({ ok: true, data: { toReview: [], reviews: [] } });
    expect(calls()[0]!.headers.get("X-Receipt-Token")).toBe(PROOF);
  });
});
