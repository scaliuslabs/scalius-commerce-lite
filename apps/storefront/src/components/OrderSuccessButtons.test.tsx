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

  const prefill = { name: "Rahim Uddin", email: "rahim@example.test", phone: "+8801712345678" };

  async function renderReceipt(accountLinked: boolean) {
    await act(async () => {
      root.render(
        <OrderSuccessButtons
          orderId="ord_1"
          accountLinked={accountLinked}
          accountPrefill={prefill}
          copy={ENGLISH_CHECKOUT_LANGUAGE_DATA}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function button(label: string) {
    return [...host.querySelectorAll("button")].find((element) => element.textContent === label);
  }

  it("shows a signed-in buyer's own saved order as one line with a link to it", async () => {
    document.cookie = "cs_auth=1; Path=/";
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await renderReceipt(true);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/customer-auth/orders/ord_1",
      { credentials: "same-origin", cache: "no-store" },
    );
    expect(host.textContent).toContain("Saved to your account · View order");
    expect(host.querySelector('a[href="/account/orders/ord_1"]')?.textContent).toBe("View order");
    expect(button("Save to my account")).toBeUndefined();
  });

  it("hides the account line for an order saved to someone else's account", async () => {
    document.cookie = "cs_auth=1; Path=/";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 404 })));

    await renderReceipt(true);

    expect(host.textContent).not.toContain("Saved to your account");
    expect(button("Save to my account")).toBeUndefined();
    expect(button("Sign in")).toBeUndefined();
  });

  it("offers one save action to a signed-in buyer and saves on click", async () => {
    document.cookie = "cs_auth=1; Path=/";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { orderId: "ord_1" } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await renderReceipt(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(host.querySelectorAll("button")).toHaveLength(2); // print + save
    await act(async () => {
      button("Save to my account")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/order-receipt/claim-account", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ orderId: "ord_1" }),
    }));
    expect(host.textContent).toContain("Saved to your account · View order");
  });

  it("asks a signed-out buyer of a saved order to sign in, pre-filled from the order", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const opened: unknown[] = [];
    const listener = (event: Event) => opened.push((event as CustomEvent).detail);
    window.addEventListener("open-auth-modal", listener);

    await renderReceipt(true);
    expect(host.textContent).toContain("Sign in to see this order in your account");
    act(() => button("Sign in")!.click());
    window.removeEventListener("open-auth-modal", listener);

    expect(opened).toEqual([{ prefill }]);
    expect(button("Create account")).toBeUndefined();
  });

  it("creates an account from the receipt and then saves the order to it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { orderId: "ord_1" } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const opened: unknown[] = [];
    const listener = (event: Event) => opened.push((event as CustomEvent).detail);
    window.addEventListener("open-auth-modal", listener);

    await renderReceipt(false);
    expect(host.textContent).toContain("Create an account to track this order");
    act(() => button("Create account")!.click());
    window.removeEventListener("open-auth-modal", listener);
    expect(opened).toEqual([{ prefill }]);
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(new CustomEvent("customer-login"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/order-receipt/claim-account", expect.anything());
    expect(host.textContent).toContain("Saved to your account · View order");
  });

  it("keeps the save action and says so when saving fails", async () => {
    document.cookie = "cs_auth=1; Path=/";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 500 })));

    await renderReceipt(false);
    await act(async () => {
      button("Save to my account")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain(ENGLISH_CHECKOUT_LANGUAGE_DATA.orderReceiptSaveFailedText);
    expect(button("Save to my account")?.disabled).toBe(false);
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
