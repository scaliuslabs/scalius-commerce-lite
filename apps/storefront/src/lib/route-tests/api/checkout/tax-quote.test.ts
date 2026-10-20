import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  shouldRejectCrossOriginCookieRequest: vi.fn(() => false),
}));

vi.mock("@/lib/api/transport", () => ({
  apiFetch: mocks.apiFetch,
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
      deliveryMethodKind: "delivery",
      requiresShipping: true,
      pickup: null,
      allowedPaymentMethods: ["cod"],
      shippingMethod: {
        id: "ship_1",
        name: "Standard delivery",
        description: "Delivered within 2–3 business days",
        baseAmountMinor: 5_000,
        feeWaived: false,
      },
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
  mocks.shouldRejectCrossOriginCookieRequest.mockReturnValue(false);
  mocks.apiFetch.mockResolvedValue(new Response(
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
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("enforces the request byte limit before parsing or forwarding", async () => {
    const response = await POST({
      request: storefrontRequest(requestPayload(), {
        "Content-Length": String(257 * 1024),
      }),
    } as never);

    expect(response.status).toBe(413);
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it("forwards only normalized server-resolvable inputs to the exact public endpoint", async () => {
    const response = await POST({
      request: storefrontRequest(requestPayload()),
    } as never);

    expect(response.status).toBe(200);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    const [apiPath, init, policy] = mocks.apiFetch.mock.calls[0];
    expect(apiPath).toBe("/orders/tax-quote");
    expect(policy).toEqual({ retries: 0, timeout: 8_000, auth: false });
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

  it("forwards the private customer session so the quote uses account identity", async () => {
    const response = await POST({
      request: storefrontRequest(requestPayload(), {
        Cookie: "theme=light; cs_tok=customer_session_1; locale=en",
      }),
    } as never);

    expect(response.status).toBe(200);
    const [, init] = mocks.apiFetch.mock.calls[0];
    expect(new Headers(init.headers).get("X-Customer-Session")).toBe(
      "customer_session_1",
    );
    expect(new Headers(init.headers).get("Cookie")).toBeNull();
  });

  it("returns a safe error without reflecting upstream details or buyer PII", async () => {
    mocks.apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({
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

  it("forwards only bounded cart-repair issues from a validation failure", async () => {
    mocks.apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      success: false,
      error: {
        code: "validation_error",
        message: "Phone +8801700000000 saw a stale price",
        details: {
          itemIssues: [{
            index: 0,
            cartKey: "line_1",
            productId: "prod_1",
            variantId: "var_1",
            code: "price_changed",
            action: "refresh_item",
            message: "The price changed.",
            productName: "Cotton Panjabi",
            variantLabel: "M / Blue",
            requestedQuantity: 2,
            submittedPrice: 140,
            currentPrice: 150,
            buyerPhone: "+8801700000000",
          }],
        },
      },
    }), { status: 422 }));

    const response = await POST({
      request: storefrontRequest(requestPayload()),
    } as never);
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(422);
    expect(body).toMatchObject({
      success: false,
      error: "Current checkout total is unavailable",
      details: {
        itemIssues: [expect.objectContaining({
          cartKey: "line_1",
          code: "price_changed",
          currentPrice: 150,
        })],
      },
    });
    expect(JSON.stringify(body)).not.toContain("+8801700000000");
    expect(JSON.stringify(body)).not.toContain("buyerPhone");
  });

  it("says only that the delivery rate was refused, so the cart can re-read the rates", async () => {
    mocks.apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      success: false,
      error: {
        code: "validation_error",
        message: "This delivery option isn't available for the selected address.",
        details: { reason: "delivery_rate_unavailable", zoneId: "zone_internal" },
      },
    }), { status: 400 }));

    const response = await POST({
      request: storefrontRequest(requestPayload()),
    } as never);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: "Current checkout total is unavailable",
      details: { reason: "delivery_rate_unavailable" },
    });
  });

  it("forwards a store app's bounded rules, never the upstream message", async () => {
    mocks.apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      success: false,
      error: {
        code: "validation_error",
        message: "Phone +8801700000000 blocked by app",
        details: {
          reason: "cart_rules",
          ruleErrors: [
            { code: "max_qty", message: "At most 10 per order.", index: 0, cartKey: "line_1", appSecret: "x" },
            { code: "min_total", message: "Spend ৳500 to check out.", index: null, cartKey: null },
          ],
        },
      },
    }), { status: 400 }));

    const response = await POST({ request: storefrontRequest(requestPayload()) } as never);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: "Current checkout total is unavailable",
      details: {
        reason: "cart_rules",
        ruleErrors: [
          { code: "max_qty", message: "At most 10 per order.", index: 0, cartKey: "line_1" },
          { code: "min_total", message: "Spend ৳500 to check out.", index: null, cartKey: null },
        ],
      },
    });
  });

  it("forwards the options still offered when a store app hid the chosen one", async () => {
    const shippingRates = [{ id: "ship_2", name: "Standard", kind: "delivery", amount: 60, amountMinor: 6_000 }];
    mocks.apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      success: false,
      error: { code: "validation_error", details: { reason: "delivery_rate_unavailable", shippingRates } },
    }), { status: 400 }));

    const response = await POST({ request: storefrontRequest(requestPayload()) } as never);

    expect(await response.json()).toEqual({
      success: false,
      error: "Current checkout total is unavailable",
      details: { reason: "delivery_rate_unavailable", shippingRates },
    });
  });

  it("passes a quote's app options, methods and discount lines through", async () => {
    const envelope = quoteEnvelope();
    const data = envelope.data as Record<string, unknown>;
    mocks.apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      ...envelope,
      data: {
        ...data,
        shippingRates: [{ id: "ship_1", name: "Standard delivery", kind: "delivery", amount: 50, amountMinor: 5_000 }],
        paymentMethods: [{ id: "cod", name: "Pay at the door" }],
        discounts: [{ promotionId: null, appId: "app_1", title: "Loyalty", code: null, amount: 20, shippingAmount: 0 }],
      },
    }), { status: 200 }));

    const response = await POST({ request: storefrontRequest(requestPayload()) } as never);
    const body = await response.json() as { data: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(body.data.shippingRates).toEqual([
      { id: "ship_1", name: "Standard delivery", kind: "delivery", amount: 50, amountMinor: 5_000 },
    ]);
    expect(body.data.paymentMethods).toEqual([{ id: "cod", name: "Pay at the door" }]);
    expect(body.data.discounts).toEqual([
      { promotionId: null, appId: "app_1", title: "Loyalty", code: null, amount: 20, shippingAmount: 0 },
    ]);
  });

  it("fails closed when the upstream success payload violates the quote contract", async () => {
    mocks.apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({
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
