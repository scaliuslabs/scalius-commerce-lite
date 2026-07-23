// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import OrderSuccessButtons from "./OrderSuccessButtons";

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
  });

  it("renders only the actions returned by eligible-only policy projection", () => {
    act(() => {
      root.render(
        <OrderSuccessButtons
          orderId="ord_1"
          supportRequestIntro="Choose an available request."
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

    expect(host.textContent).toContain("Choose an available request.");
    expect(host.textContent).toContain("Request cancellation");
    expect(host.textContent).not.toContain("Request return");
  });

  it("renders unavailable actions as disabled with the exact reason", () => {
    act(() => {
      root.render(
        <OrderSuccessButtons
          orderId="ord_1"
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
    expect(returnButton?.disabled).toBe(true);
    expect(returnButton?.textContent).toContain(
      "Return requests are available after the order ships.",
    );
  });

  it("shows accepted request progress instead of stale review copy", () => {
    act(() => {
      root.render(
        <OrderSuccessButtons
          orderId="ord_1"
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

    expect(host.textContent).toContain("Cancellation request rejected");
    expect(host.textContent).toContain("Request cancellation");
    expect(host.querySelector('button:not([disabled])')?.textContent).toContain("Continue shopping");
    expect([...host.querySelectorAll("button")].some((button) =>
      button.textContent?.includes("Request cancellation") && !button.disabled
    )).toBe(true);
  });
});
