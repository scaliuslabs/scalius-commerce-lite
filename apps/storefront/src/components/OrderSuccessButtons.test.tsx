// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import OrderSuccessButtons from "./OrderSuccessButtons";
import {
  BANGLA_CHECKOUT_LANGUAGE_DATA,
  ENGLISH_CHECKOUT_LANGUAGE_DATA,
} from "@scalius/shared/checkout-language";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe("OrderSuccessButtons customer request policy rendering", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    host = document.createElement("div");
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.cookie = "cs_auth=; Max-Age=0; Path=/";
    vi.unstubAllGlobals();
  });

  it("recognizes an authenticated order that is already in the account", async () => {
    document.cookie = "cs_auth=1; Path=/";
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      root.render(
        <OrderSuccessButtons
          orderId="ord_owned"
          copy={ENGLISH_CHECKOUT_LANGUAGE_DATA}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/customer-auth/orders/ord_owned",
      { credentials: "same-origin", cache: "no-store" },
    );
    expect(host.textContent).toContain(
      ENGLISH_CHECKOUT_LANGUAGE_DATA.orderReceiptSavedAccountTitleText,
    );
    expect(host.textContent).toContain(
      ENGLISH_CHECKOUT_LANGUAGE_DATA.orderReceiptViewInAccountText,
    );
    expect(host.textContent).not.toContain("Save to my account");
  });

  it("renders only the actions returned by eligible-only policy projection", () => {
    act(() => {
      root.render(
        <OrderSuccessButtons
          orderId="ord_1"
          copy={ENGLISH_CHECKOUT_LANGUAGE_DATA}
          supportRequestActions={[{
            type: "cancel_pre_shipment",
            label: "Request cancellation",
            description: "Ask the store to review this order before it ships.",
            eligible: true,
            disabledReason: null,
          }]}
        />,
      );
    });

    expect(host.textContent).toContain("Need help?");
    expect(host.textContent).toContain("Request cancellation");
    expect(host.textContent).not.toContain("Ask the store to review this order before it ships.");
    expect(host.textContent).not.toContain("Request return");
  });

  it("uses safe localized unavailability copy instead of backend prose", () => {
    act(() => {
      root.render(
        <OrderSuccessButtons
          orderId="ord_1"
          copy={ENGLISH_CHECKOUT_LANGUAGE_DATA}
          supportRequestActions={[
            {
              type: "return",
              label: "Request return",
              description: "Ask the store to review a return for this order.",
              eligible: false,
              disabledReason: "Return requests are available after the order ships.",
            },
          ]}
        />,
      );
    });

    const returnButton = [...host.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Request return"));
    expect(returnButton).toBeUndefined();
    expect(host.textContent).toContain("Support requests are not available for this order right now.");
    expect(host.textContent).not.toContain("Return requests are available after the order ships.");
  });

  it("shows accepted request progress instead of stale review copy", () => {
    act(() => {
      root.render(
        <OrderSuccessButtons
          orderId="ord_1"
          copy={ENGLISH_CHECKOUT_LANGUAGE_DATA}
          supportRequests={[{
            id: "request_1",
            orderId: "ord_1",
            customerId: null,
            type: "return",
            status: "approved",
            active: true,
            severity: "success",
            label: "Return request approved",
            actionLabel: "Request return",
            reason: "The size is not suitable.",
            message: null,
            submittedAt: "2026-07-21T00:00:00.000Z",
            resolvedAt: null,
            createdAt: "2026-07-21T00:00:00.000Z",
            updatedAt: "2026-07-21T00:05:00.000Z",
          }]}
        />,
      );
    });

    expect(host.textContent).toContain(
      "The store accepted this request. Check the order status for progress.",
    );
    expect(host.textContent).not.toContain(
      "The store team will review this request before making any order changes.",
    );
  });

  it("keeps newly eligible actions available after an earlier request is settled", () => {
    act(() => {
      root.render(
        <OrderSuccessButtons
          orderId="ord_1"
          copy={ENGLISH_CHECKOUT_LANGUAGE_DATA}
          supportRequests={[{
            id: "request_1",
            orderId: "ord_1",
            customerId: null,
            type: "cancel_pre_shipment",
            status: "rejected",
            active: false,
            severity: "danger",
            label: "Cancellation request rejected",
            actionLabel: "Request cancellation",
            reason: "Changed my mind.",
            message: null,
            submittedAt: "2026-07-21T00:00:00.000Z",
            resolvedAt: "2026-07-21T00:05:00.000Z",
            createdAt: "2026-07-21T00:00:00.000Z",
            updatedAt: "2026-07-21T00:05:00.000Z",
          }]}
          supportRequestActions={[{
            type: "cancel_pre_shipment",
            label: "Request cancellation",
            description: "Ask the store to review this order before it ships.",
            eligible: true,
            disabledReason: null,
          }]}
        />,
      );
    });

    expect(host.textContent).toContain("Request cancellation · Rejected");
    expect(host.textContent).toContain("Request cancellation");
    expect(host.querySelector('a[href="/"]')?.textContent).toContain("Continue shopping");
    expect(host.querySelector('a[href="/"]')?.getAttribute("data-astro-prefetch")).toBe("false");
    expect([...host.querySelectorAll("button")].some((button) =>
      button.textContent?.includes("Request cancellation") && !button.disabled
    )).toBe(true);
  });

  it("maps backend support identifiers to Bangla buyer copy", () => {
    act(() => {
      root.render(
        <OrderSuccessButtons
          orderId="ord_1"
          copy={BANGLA_CHECKOUT_LANGUAGE_DATA}
          supportRequests={[{
            id: "request_1",
            orderId: "ord_1",
            customerId: null,
            type: "return",
            status: "approved",
            active: true,
            severity: "success",
            label: "Return request approved",
            actionLabel: "Request return",
            reason: "Wrong size",
            message: null,
            submittedAt: "2026-07-21T00:00:00.000Z",
            resolvedAt: null,
            createdAt: "2026-07-21T00:00:00.000Z",
            updatedAt: "2026-07-21T00:05:00.000Z",
          }]}
        />,
      );
    });

    expect(host.textContent).toContain("সাহায্য প্রয়োজন?");
    expect(host.textContent).toContain("ফেরতের অনুরোধ করুন · গৃহীত");
    expect(host.textContent).toContain("দোকান অনুরোধটি গ্রহণ করেছে");
    expect(host.textContent).not.toContain("Return request approved");
  });
});
