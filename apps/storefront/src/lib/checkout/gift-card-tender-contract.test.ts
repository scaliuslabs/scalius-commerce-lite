// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  normalizeTaxQuoteRequest,
  parseTaxQuoteEnvelope,
  quoteAmountDue,
  TaxQuoteContractError,
} from "./tax-quote-contract";
import { buildTaxQuoteRequest, fetchAuthoritativeTaxQuote, TaxQuoteUnavailableError } from "./tax-quote-client";
import { createOrder } from "./create-order";

const handle = (seed: string) => `gch_${seed.repeat(48).slice(0, 48)}`;

function quoteData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    valid: true,
    quoteFingerprint: "taxq_abcdefghijklmnopqrstuv",
    displayLabel: "VAT",
    pricesIncludeTax: false,
    shippingTaxed: false,
    currencyCode: "BDT",
    decimalPlaces: 2,
    settingsVersion: 1,
    subtotalMinor: 100_000,
    subtotalAmount: 1000,
    shippingMinor: 0,
    shippingAmount: 0,
    discountMinor: 0,
    discountAmount: 0,
    taxMinor: 0,
    taxAmount: 0,
    totalMinor: 100_000,
    totalAmount: 1000,
    shippingMethod: null,
    deliveryMethodKind: null,
    requiresShipping: false,
    pickup: null,
    allowedPaymentMethods: ["sslcommerz"],
    discounts: [],
    offers: [],
    rejectedCodes: [],
    items: [{
      cartKey: "line_1",
      productId: "prod_1",
      variantId: "var_1",
      quantity: 1,
      unitPrice: 1000,
      productName: "Panjabi",
      variantLabel: null,
      fulfillmentType: "service",
      properties: [],
    }],
    ...overrides,
  };
}

const tender = {
  giftCardTenders: [{ handle: handle("a"), last4: "7K2Q", applied: 400, appliedMinor: 40_000, balance: 400, balanceMinor: 40_000 }],
  giftCardIssues: [],
  amountDue: 600,
  amountDueMinor: 60_000,
};

function checkoutData(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    checkoutRequestId: "checkout_req_test",
    expectedQuoteFingerprint: "taxq_abcdefghijklmnopqrstuv",
    customerName: "Buyer",
    customerPhone: "+8801700000000",
    deliveryMode: "none",
    cartItems: JSON.stringify({ line_1: { id: "prod_1", variantId: "var_1", quantity: 1, price: 1000, name: "Panjabi" } }),
    ...extra,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tax-quote request with gift cards", () => {
  it("is the old request when no cards are applied", () => {
    expect(buildTaxQuoteRequest(checkoutData())).not.toHaveProperty("giftCards");
    expect(buildTaxQuoteRequest(checkoutData({ giftCards: [] }))).not.toHaveProperty("giftCards");
  });

  it("carries the apply handles, never a code", () => {
    const request = buildTaxQuoteRequest(checkoutData({ giftCards: [{ handle: handle("a") }] }));
    expect(request.giftCards).toEqual([{ handle: handle("a") }]);
    expect(JSON.stringify(request)).not.toMatch(/"code"/);
  });

  it("refuses more than five cards, repeats and anything that is not a handle", () => {
    const items = [{ productId: "p", variantId: "v", quantity: 1 }];
    const six = ["a", "b", "c", "d", "e", "f"].map((seed) => ({ handle: handle(seed) }));
    expect(() => normalizeTaxQuoteRequest({ items, discountCodes: [], giftCards: six })).toThrow(TaxQuoteContractError);
    expect(() => normalizeTaxQuoteRequest({
      items, discountCodes: [], giftCards: [{ handle: handle("a") }, { handle: handle("a") }],
    })).toThrow(TaxQuoteContractError);
    expect(() => normalizeTaxQuoteRequest({
      items, discountCodes: [], giftCards: [{ handle: "ABCD-EFGH-JKMN-7K2Q" }],
    })).toThrow(TaxQuoteContractError);
  });
});

describe("tax-quote response with gift cards", () => {
  it("parses the tender and what is left to pay", () => {
    const quote = parseTaxQuoteEnvelope({ success: true, data: quoteData(tender) });
    expect(quote.giftCardTenders).toEqual(tender.giftCardTenders);
    expect(quote.amountDueMinor).toBe(60_000);
    expect(quoteAmountDue(quote)).toEqual({ amountDue: 600, amountDueMinor: 60_000 });
  });

  it("stays the old quote when the API reports no tender, and the amount due is the total", () => {
    const quote = parseTaxQuoteEnvelope({ success: true, data: quoteData() });
    expect(quote).not.toHaveProperty("amountDue");
    expect(quote).not.toHaveProperty("giftCardTenders");
    expect(quoteAmountDue(quote)).toEqual({ amountDue: 1000, amountDueMinor: 100_000 });
  });

  it("refuses a tender that does not add up to the total", () => {
    expect(() => parseTaxQuoteEnvelope({
      success: true,
      data: quoteData({ ...tender, amountDue: 500, amountDueMinor: 50_000 }),
    })).toThrow(TaxQuoteContractError);
    expect(() => parseTaxQuoteEnvelope({
      success: true,
      data: quoteData({ ...tender, giftCardTenders: [{ ...tender.giftCardTenders[0], applied: 1 }] }),
    })).toThrow(TaxQuoteContractError);
  });

  it("refuses a tender for a card the request did not send", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ success: true, data: quoteData(tender) })));
    await expect(fetchAuthoritativeTaxQuote(checkoutData(), fetcher as unknown as typeof fetch))
      .rejects.toBeInstanceOf(TaxQuoteUnavailableError);
    await expect(fetchAuthoritativeTaxQuote(
      checkoutData({ giftCards: [{ handle: handle("a") }] }),
      fetcher as unknown as typeof fetch,
    )).resolves.toMatchObject({ amountDueMinor: 60_000 });
  });
});

describe("create-order payload with gift cards", () => {
  function stubOrderFetch() {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ success: true, data: { id: "ord_1" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("is the old payload without cards", async () => {
    const fetchMock = stubOrderFetch();
    await createOrder(checkoutData(), "cod");
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body).not.toHaveProperty("giftCards");
    expect(body).not.toHaveProperty("expectedAmountDueMinor");
    expect(body.paymentMethod).toBe("cod");
  });

  it("sends the handles and the amount due the buyer reviewed", async () => {
    const fetchMock = stubOrderFetch();
    await createOrder(checkoutData({
      giftCards: [{ handle: handle("a") }],
      expectedAmountDueMinor: 0,
    }), "gift_card");
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.giftCards).toEqual([{ handle: handle("a") }]);
    expect(body.expectedAmountDueMinor).toBe(0);
    expect(body.paymentMethod).toBe("gift_card");
  });

  it("will not place an order with cards whose amount due was never quoted", async () => {
    const fetchMock = stubOrderFetch();
    await expect(createOrder(checkoutData({ giftCards: [{ handle: handle("a") }] }), "cod")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
