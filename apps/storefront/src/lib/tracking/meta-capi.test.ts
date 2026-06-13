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
    expect(payload.userData).toMatchObject({
      em: "buyer@example.com",
      ph: "+8801712345678",
      client_user_agent: navigator.userAgent,
    });
  });
});
