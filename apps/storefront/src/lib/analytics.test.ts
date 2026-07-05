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
  shouldUsePartytown,
  trackFbAddToCart,
  trackFbInitiateCheckout,
  trackFbPurchase,
  trackFbSearch,
  trackFbViewContent,
} from "./analytics";

describe("storefront analytics", () => {
  beforeEach(() => {
    sendServerEventMock.mockClear();
    createMetaEventIdMock.mockClear();
    window.fbq = vi.fn() as unknown as NonNullable<Window["fbq"]>;
    window.zaraz = {
      ecommerce: vi.fn().mockResolvedValue(undefined),
      track: vi.fn().mockResolvedValue(undefined),
    };
    window.dataLayer = [];
  });

  it("keeps Cloudflare Web Analytics out of Partytown", () => {
    expect(
      shouldUsePartytown({
        id: "analytics_1",
        name: "Cloudflare Web Analytics",
        type: "cloudflare_web_analytics",
        isActive: true,
        usePartytown: true,
        config: "",
        location: "body_end",
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).toBe(false);
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
});
