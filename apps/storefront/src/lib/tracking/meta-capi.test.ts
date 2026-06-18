// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMetaCapiEventMock = vi.hoisted(() => vi.fn());

vi.mock("../api/tracking", () => ({
  sendMetaCapiEvent: sendMetaCapiEventMock,
}));

import { sendServerEvent } from "./meta-capi";

describe("sendServerEvent", () => {
  beforeEach(() => {
    sendMetaCapiEventMock.mockClear();
    sessionStorage.clear();
    window.history.replaceState(null, "", "/products/widget");
  });

  it("does not enrich broad events with checkout PII from sessionStorage", () => {
    sessionStorage.setItem(
      "scalius_checkout_data",
      JSON.stringify({
        customerEmail: "buyer@example.com",
        customerPhone: "+8801712345678",
        customerName: "Private Buyer",
        cityName: "Dhaka",
      }),
    );
    sessionStorage.setItem("scalius_user_email", "buyer@example.com");
    sessionStorage.setItem("scalius_user_phone", "+8801712345678");
    sessionStorage.setItem("scalius_user_name", "Private Buyer");
    sessionStorage.setItem("scalius_user_city", "Dhaka");

    sendServerEvent({
      eventName: "ViewContent",
      customData: {
        content_ids: ["product-1"],
        content_type: "product",
      },
    });

    expect(sendMetaCapiEventMock).toHaveBeenCalledTimes(1);
    const payload = sendMetaCapiEventMock.mock.calls[0][0];
    expect(payload.eventName).toBe("ViewContent");
    expect(payload.eventSourceUrl).toBe("http://localhost:3000/products/widget");
    expect(payload.userData).not.toHaveProperty("em");
    expect(payload.userData).not.toHaveProperty("ph");
    expect(payload.userData).not.toHaveProperty("fn");
    expect(payload.userData).not.toHaveProperty("ln");
    expect(payload.userData).not.toHaveProperty("ct");
    expect(payload.userData.client_user_agent).toBe(navigator.userAgent);
  });

  it("keeps explicitly supplied user data for narrow conversion events", () => {
    sendServerEvent({
      eventId: "Purchase:order_1",
      eventName: "Purchase",
      userData: {
        em: "buyer@example.com",
        ph: "+8801712345678",
      },
      customData: {
        order_id: "order_1",
        currency: "BDT",
        value: 1000,
      },
    });

    const payload = sendMetaCapiEventMock.mock.calls[0][0];
    expect(payload.eventId).toBe("Purchase:order_1");
    expect(payload.userData).toMatchObject({
      em: "buyer@example.com",
      ph: "+8801712345678",
      client_user_agent: navigator.userAgent,
    });
  });

  it("strips checkout secrets from event source URLs before dispatch", () => {
    window.history.replaceState(
      null,
      "",
      "/order-success?orderId=order_1&token=receipt_secret&payment_intent_client_secret=pi_secret&keep=yes",
    );

    sendServerEvent({
      eventId: "Purchase:order_1",
      eventName: "Purchase",
      customData: {
        order_id: "order_1",
      },
    });

    const payload = sendMetaCapiEventMock.mock.calls[0][0];
    expect(payload.eventSourceUrl).toBe(
      "http://localhost:3000/order-success?orderId=order_1&keep=yes",
    );
  });
});
