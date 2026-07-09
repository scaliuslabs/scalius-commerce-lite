import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createApiUrl: vi.fn((path: string) => `https://api.example.test/api/v1${path}`),
  fetchWithRetry: vi.fn(),
  shouldRejectCrossOriginCookieRequest: vi.fn(() => false),
}));

vi.mock("@/lib/api/client", () => ({
  createApiUrl: mocks.createApiUrl,
  fetchWithRetry: mocks.fetchWithRetry,
}));

vi.mock("@scalius/shared/request-origin-guard", () => ({
  shouldRejectCrossOriginCookieRequest: mocks.shouldRejectCrossOriginCookieRequest,
}));

import { POST } from "../../../../pages/api/checkout/tax-quote";

function requestPayload(): Record<string, unknown> {
  return {
    items: [{
      cartKey: "line_1",
      productId: "prod_1",
      variantId: "var_1",
      quantity: 2,
      productName: "Cotton Panjabi",
      variantLabel: "M / Blue",
      price: 999_999,
      taxClassId: "forged_tax_class",
    }],
    city: "city_1",
    zone: "zone_1",
    area: "area_1",
    shippingMethodId: "ship_1",
    discountCode: "SAVE20",
    customerPhone: "+8801700000000",
    subtotal: 999_999,
  };
}

function quoteEnvelope(): Record<string, unknown> {
  return {
    success: true,
    data: {
      valid: true,
      quoteFingerprint: "taxq_abcdefghijklmnopqrstuv",
      displayLabel: "VAT",
      pricesIncludeTax: false,
      shippingTaxed: true,
      currencyCode: "BDT",
      decimalPlaces: 2,
      settingsVersion: 2,
      subtotalMinor: 30_000,
      subtotalAmount: 300,
      shippingMinor: 5_000,
      shippingAmount: 50,
      discountMinor: 2_000,
      discountAmount: 20,
      taxMinor: 4_950,
      taxAmount: 49.5,
      totalMinor: 37_950,
      totalAmount: 379.5,
      items: [{
        cartKey: "line_1",
        productId: "prod_1",
        variantId: "var_1",
        quantity: 2,
        unitPrice: 150,
        productName: "Cotton Panjabi",
        variantLabel: "M / Blue",
      }],
    },
  };
}

function storefrontRequest(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Request {
  const request = new Request("https://storefront.example.test/api/checkout/tax-quote", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://storefront.example.test",
    },
    body: JSON.stringify(body),
  });
  for (const [name, value] of Object.entries(headers)) {
    request.headers.set(name, value);
  }
  return request;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createApiUrl.mockImplementation(
    (path: string) => `https://api.example.test/api/v1${path}`,
  );
  mocks.shouldRejectCrossOriginCookieRequest.mockReturnValue(false);
  mocks.fetchWithRetry.mockResolvedValue(new Response(
    JSON.stringify(quoteEnvelope()),
    { status: 200 },
  ));
});

describe("checkout tax quote proxy", () => {
  it("rejects a cross-origin request even when no cookie is present", async () => {
    const response = await POST({
      request: storefrontRequest(requestPayload(), {
        Origin: "https://evil.example.test",
      }),
    } as never);

    expect(response.status).toBe(403);
    expect(mocks.fetchWithRetry).not.toHaveBeenCalled();
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("enforces the request byte limit before parsing or forwarding", async () => {
    const response = await POST({
      request: storefrontRequest(requestPayload(), {
        "Content-Length": String(257 * 1024),
      }),
    } as never);

    expect(response.status).toBe(413);
    expect(mocks.fetchWithRetry).not.toHaveBeenCalled();
  });

  it("forwards only normalized server-resolvable inputs to the exact public endpoint", async () => {
    const response = await POST({
      request: storefrontRequest(requestPayload()),
    } as never);

    expect(response.status).toBe(200);
    expect(mocks.createApiUrl).toHaveBeenCalledWith("/orders/tax-quote");
    expect(mocks.fetchWithRetry).toHaveBeenCalledTimes(1);
    const [url, init, retries, timeout, requiresAuth] =
      mocks.fetchWithRetry.mock.calls[0];
    expect(url).toBe("https://api.example.test/api/v1/orders/tax-quote");
    expect(retries).toBe(0);
    expect(timeout).toBe(8_000);
    expect(requiresAuth).toBe(false);
    expect(init).toMatchObject({ method: "POST", cache: "no-store" });

    const forwarded = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(forwarded).toMatchObject({
      city: "city_1",
      zone: "zone_1",
      shippingMethodId: "ship_1",
      customerPhone: "+8801700000000",
    });
    expect(JSON.stringify(forwarded)).not.toContain("999999");
    expect(JSON.stringify(forwarded)).not.toContain("taxClass");
  });

  it("returns a safe error without reflecting upstream details or buyer PII", async () => {
    mocks.fetchWithRetry.mockResolvedValueOnce(new Response(JSON.stringify({
      success: false,
      error: "Phone +8801700000000 rejected by provider",
    }), { status: 422 }));

    const response = await POST({
      request: storefrontRequest(requestPayload()),
    } as never);
    const body = await response.text();

    expect(response.status).toBe(422);
    expect(body).toContain("Current checkout total is unavailable");
    expect(body).not.toContain("+8801700000000");
    expect(body).not.toContain("provider");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("fails closed when the upstream success payload violates the quote contract", async () => {
    mocks.fetchWithRetry.mockResolvedValueOnce(new Response(JSON.stringify({
      ...quoteEnvelope(),
      data: {
        ...(quoteEnvelope().data as Record<string, unknown>),
        totalMinor: 1,
      },
    }), { status: 200 }));

    const response = await POST({
      request: storefrontRequest(requestPayload()),
    } as never);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      success: false,
      error: "Current checkout total is unavailable",
    });
  });
});
