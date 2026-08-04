// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

const sendServerEventMock = vi.hoisted(() => vi.fn());
const createMetaEventIdMock = vi.hoisted(() =>
  vi.fn(
    (eventName: string, stableKey?: string) =>
      `${eventName}:${stableKey ?? "generated"}`,
  ),
);

vi.mock("./tracking/meta-capi", () => ({
  sendServerEvent: sendServerEventMock,
}));

vi.mock("./tracking/meta-event-id", () => ({
  createMetaEventId: createMetaEventIdMock,
}));

import {
  trackFbAddPaymentInfo,
  trackFbAddToCart,
  trackFbInitiateCheckout,
  trackFbPurchase,
  trackFbSearch,
  trackFbViewContent,
  trackStorefrontAddPaymentInfoOnce,
  trackStorefrontSearchResults,
} from "./analytics";

describe("storefront analytics", () => {
  beforeEach(() => {
    sendServerEventMock.mockClear();
    createMetaEventIdMock.mockClear();
    window.fbq = vi.fn() as unknown as NonNullable<Window["fbq"]>;
    window.ttq = {
      track: vi.fn(),
    };
    window.__TIKTOK_PIXEL_ENABLED__ = true;
    window.zaraz = {
      ecommerce: vi.fn().mockResolvedValue(undefined),
      track: vi.fn().mockResolvedValue(undefined),
    };
    window.dataLayer = [];
    sessionStorage.clear();
    delete (window as Window & { __scaliusAnalyticsDedupe?: Set<string> })
      .__scaliusAnalyticsDedupe;
  });

  it("bridges add-to-cart events to Zaraz ecommerce when available", () => {
    trackFbAddToCart({
      content_ids: ["sku_1"],
      content_name: "Test product",
      content_type: "product",
      contents: [{ id: "sku_1", quantity: 2, item_price: 250 }],
      currency: "BDT",
      value: 500,
    });

    expect(window.fbq).toHaveBeenCalledWith(
      "track",
      "AddToCart",
      expect.objectContaining({ content_name: "Test product" }),
      { eventID: "AddToCart:generated" },
    );
    expect(window.zaraz?.ecommerce).toHaveBeenCalledWith("Product Added", {
      product_id: "sku_1",
      sku: "sku_1",
      name: "Test product",
      price: 250,
      quantity: 2,
      products: [
        {
          product_id: "sku_1",
          sku: "sku_1",
          quantity: 2,
          price: 250,
          position: 1,
        },
      ],
      currency: "BDT",
      value: 500,
    });
    expect(window.dataLayer).toEqual([
      { ecommerce: null },
      {
        event: "add_to_cart",
        event_id: "AddToCart:generated",
        ecommerce: {
          currency: "BDT",
          value: 500,
          event_id: "AddToCart:generated",
          items: [
            {
              item_id: "sku_1",
              item_name: "Test product",
              price: 250,
              quantity: 2,
              index: 0,
            },
          ],
        },
      },
    ]);
    expect(sendServerEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "AddToCart:generated",
        eventName: "AddToCart",
      }),
    );
  });

  it("bridges product views and searches to GA4/GTM dataLayer", () => {
    trackFbViewContent({
      content_ids: ["sku_1"],
      content_category: "Shoes",
      content_name: "Khaki High-Top",
      content_type: "product",
      contents: [{ id: "sku_1", quantity: 1, item_price: 1200 }],
      currency: "BDT",
      value: 1200,
    });
    trackFbSearch({
      content_ids: ["sku_1"],
      currency: "BDT",
      search_string: "khaki shoes",
      value: 1200,
    });

    expect(window.dataLayer).toEqual([
      { ecommerce: null },
      {
        event: "view_item",
        event_id: "ViewContent:generated",
        ecommerce: {
          currency: "BDT",
          value: 1200,
          event_id: "ViewContent:generated",
          items: [
            {
              item_id: "sku_1",
              item_name: "Khaki High-Top",
              item_category: "Shoes",
              price: 1200,
              quantity: 1,
              index: 0,
            },
          ],
        },
      },
      {
        event: "search",
        event_id: "Search:generated",
        search_term: "khaki shoes",
        currency: "BDT",
        value: 1200,
      },
    ]);
    expect(sendServerEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "ViewContent:generated",
        eventName: "ViewContent",
      }),
    );
    expect(sendServerEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "Search:generated",
        eventName: "Search",
      }),
    );
  });

  it("tracks normalized storefront search results once as Search", () => {
    expect(
      trackStorefrontSearchResults({
        searchQuery: "  khaki   shoes ",
        products: [{ id: "sku_1", name: "Khaki High-Top", price: 1200 }],
        currency: "BDT",
      }),
    ).toBe(true);
    expect(
      trackStorefrontSearchResults({
        searchQuery: "khaki shoes",
        products: [{ id: "sku_1", name: "Khaki High-Top", price: 1200 }],
        currency: "BDT",
      }),
    ).toBe(false);
    expect(
      trackStorefrontSearchResults({
        searchQuery: "   ",
        products: [{ id: "sku_2", name: "Blank query", price: 500 }],
        currency: "BDT",
      }),
    ).toBe(false);
    expect(
      trackStorefrontSearchResults({
        searchQuery: "no matching products",
        products: [],
        currency: "BDT",
      }),
    ).toBe(true);

    expect(window.fbq).toHaveBeenCalledTimes(2);
    expect(window.fbq).toHaveBeenNthCalledWith(
      1,
      "track",
      "Search",
      {
        content_ids: ["sku_1"],
        contents: [{ id: "sku_1", quantity: 1, item_price: 1200 }],
        currency: "BDT",
        search_string: "khaki shoes",
        value: 1200,
      },
      { eventID: "Search:generated" },
    );
    expect(window.fbq).toHaveBeenNthCalledWith(
      2,
      "track",
      "Search",
      {
        content_ids: undefined,
        contents: undefined,
        currency: "BDT",
        search_string: "no matching products",
        value: undefined,
      },
      { eventID: "Search:generated" },
    );
    expect(window.fbq).not.toHaveBeenCalledWith(
      "track",
      "ViewContent",
      expect.anything(),
      expect.anything(),
    );
    expect(sendServerEventMock).toHaveBeenCalledTimes(2);
    expect(sendServerEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "Search:generated",
        eventName: "Search",
      }),
    );
  });

  it("dedupes AddPaymentInfo per checkout attempt and payment method", () => {
    const safePayload = {
      checkoutId: "chk_analytics_1",
      paymentMethod: "cod",
      content_ids: ["var_1"],
      contents: [{ id: "var_1", quantity: 2, item_price: 300 }],
      currency: "BDT",
      value: 600,
    };

    expect(trackStorefrontAddPaymentInfoOnce(safePayload)).toBe(true);
    expect(trackStorefrontAddPaymentInfoOnce(safePayload)).toBe(false);
    expect(
      trackStorefrontAddPaymentInfoOnce({
        ...safePayload,
        paymentMethod: "sslcommerz",
      }),
    ).toBe(true);
    expect(
      trackStorefrontAddPaymentInfoOnce({
        ...safePayload,
        checkoutId: "chk_analytics_2",
      }),
    ).toBe(true);

    expect(window.fbq).toHaveBeenCalledTimes(3);
    expect(window.fbq).toHaveBeenCalledWith(
      "track",
      "AddPaymentInfo",
      {
        content_category: undefined,
        content_ids: ["var_1"],
        contents: [{ id: "var_1", quantity: 2, item_price: 300 }],
        currency: "BDT",
        value: 600,
      },
      { eventID: "AddPaymentInfo:generated" },
    );
    expect(sendServerEventMock).toHaveBeenCalledTimes(3);
  });

  it("bridges checkout-start events to GA4/GTM dataLayer ecommerce", () => {
    trackFbInitiateCheckout({
      content_ids: ["sku_1", "sku_2"],
      content_category: "Snacks",
      contents: [
        { id: "sku_1", quantity: 1, item_price: 100 },
        { id: "sku_2", quantity: 3, item_price: 75 },
      ],
      currency: "BDT",
      num_items: 4,
    });

    expect(window.fbq).toHaveBeenCalledWith(
      "track",
      "InitiateCheckout",
      expect.objectContaining({ num_items: 4 }),
      { eventID: "InitiateCheckout:generated" },
    );
    expect(window.zaraz?.ecommerce).toHaveBeenCalledWith(
      "Checkout Started",
      expect.objectContaining({
        currency: "BDT",
        quantity: 4,
      }),
    );
    expect(window.dataLayer).toEqual([
      { ecommerce: null },
      {
        event: "begin_checkout",
        event_id: "InitiateCheckout:generated",
        ecommerce: {
          currency: "BDT",
          value: 325,
          num_items: 4,
          event_id: "InitiateCheckout:generated",
          items: [
            {
              item_id: "sku_1",
              item_category: "Snacks",
              price: 100,
              quantity: 1,
              index: 0,
            },
            {
              item_id: "sku_2",
              item_category: "Snacks",
              price: 75,
              quantity: 3,
              index: 1,
            },
          ],
        },
      },
    ]);
    expect(sendServerEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "InitiateCheckout:generated",
        eventName: "InitiateCheckout",
      }),
    );
  });

  it("bridges purchase events to Zaraz ecommerce without user data", () => {
    trackFbPurchase(
      {
        content_ids: ["sku_1"],
        content_type: "product",
        contents: [{ id: "sku_1", quantity: 1, item_price: 1000 }],
        currency: "BDT",
        num_items: 1,
        value: 1000,
        order_id: "order_1",
      },
      { em: "buyer@example.com" },
    );

    expect(window.fbq).toHaveBeenCalledWith(
      "track",
      "Purchase",
      expect.objectContaining({ order_id: "order_1" }),
      { eventID: "Purchase:order_1" },
    );
    expect(window.zaraz?.ecommerce).toHaveBeenCalledWith("Order Completed", {
      order_id: "order_1",
      total: 1000,
      revenue: 1000,
      currency: "BDT",
      products: [
        {
          product_id: "sku_1",
          sku: "sku_1",
          quantity: 1,
          price: 1000,
          position: 1,
        },
      ],
      quantity: 1,
    });
    expect(window.dataLayer).toEqual([
      { ecommerce: null },
      {
        event: "purchase",
        event_id: "Purchase:order_1",
        ecommerce: {
          transaction_id: "order_1",
          currency: "BDT",
          value: 1000,
          num_items: 1,
          event_id: "Purchase:order_1",
          items: [
            {
              item_id: "sku_1",
              price: 1000,
              quantity: 1,
              index: 0,
            },
          ],
        },
      },
    ]);
    expect(JSON.stringify(window.dataLayer)).not.toContain("buyer@example.com");
    expect(
      JSON.stringify(
        (window.ttq?.track as ReturnType<typeof vi.fn>).mock.calls,
      ),
    ).not.toContain("buyer@example.com");
    expect(sendServerEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "Purchase:order_1",
        eventName: "Purchase",
        userData: { em: "buyer@example.com" },
      }),
    );
  });

  it("can keep browser Purchase Pixel/Zaraz while suppressing browser CAPI", () => {
    trackFbPurchase(
      {
        content_ids: ["sku_1"],
        content_type: "product",
        contents: [{ id: "sku_1", quantity: 1, item_price: 1000 }],
        currency: "BDT",
        num_items: 1,
        value: 1000,
        order_id: "order_1",
      },
      {},
      { eventId: "Purchase:order_1", sendCapi: false },
    );

    expect(window.fbq).toHaveBeenCalledWith(
      "track",
      "Purchase",
      expect.objectContaining({ order_id: "order_1" }),
      { eventID: "Purchase:order_1" },
    );
    expect(window.zaraz?.ecommerce).toHaveBeenCalledWith(
      "Order Completed",
      expect.objectContaining({ order_id: "order_1" }),
    );
    expect(sendServerEventMock).not.toHaveBeenCalled();
  });

  it("bridges storefront commerce wrappers to TikTok standard events with event_id and no PII", () => {
    trackFbViewContent({
      content_ids: ["sku_view"],
      content_name: "Product view",
      content_type: "product",
      contents: [{ id: "sku_view", quantity: 1, item_price: 1200 }],
      currency: "BDT",
      value: 1200,
    });
    trackFbAddToCart({
      content_ids: ["sku_cart"],
      content_type: "product",
      contents: [{ id: "sku_cart", quantity: 2, item_price: 300 }],
      currency: "BDT",
      value: 600,
    });
    trackFbInitiateCheckout({
      content_ids: ["sku_cart"],
      contents: [{ id: "sku_cart", quantity: 2, item_price: 300 }],
      currency: "BDT",
      num_items: 2,
      value: 600,
    });
    trackFbAddPaymentInfo({
      content_ids: ["sku_cart"],
      contents: [{ id: "sku_cart", quantity: 2, item_price: 300 }],
      currency: "BDT",
      value: 600,
    });
    trackFbPurchase(
      {
        content_ids: ["sku_cart"],
        content_type: "product",
        contents: [{ id: "sku_cart", quantity: 2, item_price: 300 }],
        currency: "BDT",
        num_items: 2,
        value: 600,
        order_id: "order_1",
      },
      { em: "buyer@example.com", ph: "+8801712345678" },
    );
    trackFbSearch({
      content_ids: ["sku_view"],
      contents: [{ id: "sku_view", quantity: 1 }],
      currency: "BDT",
      search_string: "khaki shoes",
      value: 1200,
    });

    expect(window.ttq?.track).toHaveBeenCalledWith("ViewContent", {
      event_id: "ViewContent:generated",
      content_type: "product",
      content_ids: ["sku_view"],
      contents: [{ content_id: "sku_view", quantity: 1 }],
      quantity: 1,
      currency: "BDT",
      value: 1200,
    });
    expect(window.ttq?.track).toHaveBeenCalledWith("AddToCart", {
      event_id: "AddToCart:generated",
      content_type: "product",
      content_ids: ["sku_cart"],
      contents: [{ content_id: "sku_cart", quantity: 2 }],
      quantity: 2,
      currency: "BDT",
      value: 600,
    });
    expect(window.ttq?.track).toHaveBeenCalledWith("InitiateCheckout", {
      event_id: "InitiateCheckout:generated",
      content_type: "product",
      content_ids: ["sku_cart"],
      contents: [{ content_id: "sku_cart", quantity: 2 }],
      quantity: 2,
      currency: "BDT",
      value: 600,
    });
    expect(window.ttq?.track).toHaveBeenCalledWith("AddPaymentInfo", {
      event_id: "AddPaymentInfo:generated",
      content_type: "product",
      content_ids: ["sku_cart"],
      contents: [{ content_id: "sku_cart", quantity: 2 }],
      quantity: 2,
      currency: "BDT",
      value: 600,
    });
    expect(window.ttq?.track).toHaveBeenCalledWith("Purchase", {
      event_id: "Purchase:order_1",
      content_type: "product",
      content_ids: ["sku_cart"],
      contents: [{ content_id: "sku_cart", quantity: 2 }],
      quantity: 2,
      currency: "BDT",
      value: 600,
    });
    expect(window.ttq?.track).toHaveBeenCalledWith("Search", {
      event_id: "Search:generated",
      content_type: "product",
      content_ids: ["sku_view"],
      contents: [{ content_id: "sku_view", quantity: 1 }],
      quantity: 1,
      currency: "BDT",
      value: 1200,
      search_string: "khaki shoes",
    });

    const tiktokPayloads = JSON.stringify(
      (window.ttq?.track as ReturnType<typeof vi.fn>).mock.calls,
    );
    expect(tiktokPayloads).not.toContain("buyer@example.com");
    expect(tiktokPayloads).not.toContain("+8801712345678");
  });

  it("keeps TikTok tracking a no-op when ttq is absent", () => {
    window.ttq = undefined;

    expect(() =>
      trackFbAddToCart({
        content_ids: ["sku_1"],
        contents: [{ id: "sku_1", quantity: 1, item_price: 100 }],
        currency: "BDT",
        value: 100,
      }),
    ).not.toThrow();

    expect(window.fbq).toHaveBeenCalledWith(
      "track",
      "AddToCart",
      expect.objectContaining({ content_ids: ["sku_1"] }),
      { eventID: "AddToCart:generated" },
    );
  });

  it("does not call Partytown's forwarding stub when TikTok is not configured", () => {
    window.__TIKTOK_PIXEL_ENABLED__ = false;

    trackFbViewContent({
      content_ids: ["sku_1"],
      contents: [{ id: "sku_1", quantity: 1, item_price: 100 }],
      currency: "BDT",
      value: 100,
    });

    expect(window.ttq?.track).not.toHaveBeenCalled();
    expect(window.fbq).toHaveBeenCalledWith(
      "track",
      "ViewContent",
      expect.objectContaining({ content_ids: ["sku_1"] }),
      { eventID: "ViewContent:generated" },
    );
  });

  it("does not let TikTok tracking failures break commerce events", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    window.ttq = {
      track: vi.fn(() => {
        throw new Error("TikTok unavailable");
      }),
    };

    expect(() =>
      trackFbAddToCart({
        content_ids: ["sku_1"],
        contents: [{ id: "sku_1", quantity: 1, item_price: 100 }],
        currency: "BDT",
        value: 100,
      }),
    ).not.toThrow();

    expect(warnSpy).toHaveBeenCalledWith(
      "TikTok Pixel event failed:",
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });
});
