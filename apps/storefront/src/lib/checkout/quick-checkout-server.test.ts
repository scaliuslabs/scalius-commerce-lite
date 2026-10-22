// The no-JavaScript checkout's quote: a store app's rules and hidden delivery
// options reach the server-rendered page the same way they reach the browser.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock("@/lib/api/transport", () => ({ apiFetch: mocks.apiFetch }));

import { fetchQuickCheckoutQuote } from "./quick-checkout-server";

const input = {
  cartItems: JSON.stringify({ line_1: { id: "prod_1", variantId: "var_1", quantity: 12 } }),
  deliveryMode: "delivery",
  city: "city_1",
  zone: "zone_1",
  shippingMethodId: "ship_1",
  discountCodes: "[]",
};

const refusal = (details: Record<string, unknown>) =>
  new Response(JSON.stringify({ success: false, error: { code: "validation_error", message: "No.", details } }), { status: 400 });

beforeEach(() => mocks.apiFetch.mockReset());

describe("no-JavaScript checkout quote with store app functions", () => {
  it("reports an app's rules for the page to list", async () => {
    mocks.apiFetch.mockResolvedValue(refusal({
      reason: "cart_rules",
      ruleErrors: [{ code: "max_qty", message: "At most 10 per order.", index: 0, cartKey: "line_1" }],
    }));
    await expect(fetchQuickCheckoutQuote(input, null)).resolves.toEqual({
      ok: false,
      reason: "rules",
      ruleErrors: [{ code: "max_qty", message: "At most 10 per order.", index: 0, cartKey: "line_1" }],
    });
  });

  it("reports the options left when an app hid the chosen one, and none for a plain refusal", async () => {
    const shippingRates = [{ id: "ship_2", name: "Standard", kind: "delivery", amount: 60, amountMinor: 6_000 }];
    mocks.apiFetch.mockResolvedValueOnce(refusal({ reason: "delivery_rate_unavailable", shippingRates }));
    await expect(fetchQuickCheckoutQuote(input, null)).resolves.toEqual({ ok: false, reason: "rate", shippingRates });

    mocks.apiFetch.mockResolvedValueOnce(refusal({ reason: "delivery_rate_unavailable" }));
    await expect(fetchQuickCheckoutQuote(input, null)).resolves.toEqual({ ok: false, reason: "rate", shippingRates: null });
  });
});

describe("no-JavaScript checkout quote request", () => {
  // Buyer QA B2: the server's quote said "application/json, application/json",
  // which the API could not read (500 on every Continue).
  it("sends one JSON content type, the client's locale headers and the buyer's session", async () => {
    mocks.apiFetch.mockResolvedValue(refusal({ reason: "delivery_rate_unavailable" }));
    await fetchQuickCheckoutQuote(input, "session_1");
    const headers = new Headers(mocks.apiFetch.mock.calls[0]![1].headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("x-customer-session")).toBe("session_1");
    expect(headers.get("x-storefront-language")).toBeTruthy();
  });
});
