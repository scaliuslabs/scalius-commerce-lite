// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}));

vi.mock("@/lib/api/transport", () => mocks);

import { POST } from "../../../pages/api/gift-cards/apply";

const URL = "https://storefront.example.test/api/gift-cards/apply";
const CODE = "ABCD-EFGH-JKMN-7K2Q";
const HANDLE = `gch_${"a".repeat(48)}`;

function jsonRequest(body: unknown, headers: Record<string, string> = {}) {
  return {
    request: new Request(URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://storefront.example.test",
        "cf-connecting-ip": "203.0.113.9",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  } as never;
}

describe("POST /api/gift-cards/apply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiFetch.mockResolvedValue(Response.json({
      success: true,
      data: {
        handle: HANDLE,
        handleExpiresAt: "2026-09-25T12:00:00.000Z",
        last4: "7K2Q",
        balance: 500,
        balanceMinor: 50_000,
        currencyCode: "BDT",
        expiresAt: null,
        extra: "never forwarded",
      },
    }));
  });

  it("sends the normalized code to the API in a POST body and returns the handle, not the code", async () => {
    const response = await POST(jsonRequest({ code: CODE }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const body = await response.text();
    expect(body).not.toContain("ABCD");
    expect(JSON.parse(body)).toEqual({
      success: true,
      data: {
        handle: HANDLE,
        handleExpiresAt: "2026-09-25T12:00:00.000Z",
        last4: "7K2Q",
        balance: 500,
        balanceMinor: 50_000,
        currencyCode: "BDT",
        expiresAt: null,
      },
    });
    const [path, init, policy] = mocks.apiFetch.mock.calls[0]!;
    expect(path).toBe("/checkout/gift-cards/apply");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ code: "ABCDEFGHJKMN7K2Q" });
    expect(new Headers(init.headers).get("cf-connecting-ip")).toBe("203.0.113.9");
    expect(policy).toMatchObject({ retries: 0, auth: false, batch: false });
  });

  it("answers a card the API refuses with the uniform code and no echo", async () => {
    mocks.apiFetch.mockResolvedValue(Response.json({
      success: false,
      error: { code: "GIFT_CARD_UNUSABLE", message: "This gift card can't be used." },
    }, { status: 400 }));
    const response = await POST(jsonRequest({ code: CODE }));
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ success: false, errorCode: "GIFT_CARD_UNUSABLE" });
    expect(body).not.toContain("ABCD");
  });

  it("passes a rate limit on with its wait", async () => {
    mocks.apiFetch.mockResolvedValue(Response.json({
      success: false,
      error: { code: "RATE_LIMIT", message: "Slow down", details: { retryAfterSeconds: 42 } },
    }, { status: 429 }));
    const response = await POST(jsonRequest({ code: CODE }));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
  });

  it("does not call the API for input that cannot be a code", async () => {
    const response = await POST(jsonRequest({ code: "12" }));
    expect(response.status).toBe(400);
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it("sends a plain form post back to /checkout without the code and without calling the API", async () => {
    const response = await POST({
      request: new Request(URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code: CODE }),
      }),
    } as never);
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/checkout");
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it("refuses another origin", async () => {
    const response = await POST(jsonRequest({ code: CODE }, { Origin: "https://evil.example" }));
    expect(response.status).toBe(403);
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });
});
