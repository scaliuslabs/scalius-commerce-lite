// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

const sendServerEventMock = vi.hoisted(() => vi.fn());
const createMetaEventIdMock = vi.hoisted(() =>
  vi.fn((eventName: string, stableKey?: string) =>
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
  trackFbPurchase,
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
    expect(sendServerEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "AddToCart:generated",
        eventName: "AddToCart",
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
    expect(sendServerEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "Purchase:order_1",
        eventName: "Purchase",
        userData: { em: "buyer@example.com" },
      }),
    );
  });
});
