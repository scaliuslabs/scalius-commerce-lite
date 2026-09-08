// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderPaymentsPayload } from "~/lib/api-functions/orders";
import type { Order } from "./types";
import { PaymentCard } from "./PaymentCard";

const mocks = vi.hoisted(() => ({
  canEdit: true,
  issue: vi.fn(),
  mutate: vi.fn(),
  read: vi.fn(),
}));

vi.mock("~/hooks/use-currency", () => ({ useCurrency: () => ({ symbol: "৳" }) }));
vi.mock("~/lib/order-detail-prefetch", () => ({ ORDER_DETAIL_PREFETCH_STALE_MS: 30_000 }));
vi.mock("~/hooks/use-order-action-permissions", () => ({
  useOrderActionPermissions: () => ({ canEditOrders: mocks.canEdit, canRefundOrders: false, canUpdateOrderCod: false }),
}));
vi.mock("~/lib/api-query-options/orders", () => ({
  orderPaymentsQueryOptions: (id: string) => ({ queryKey: ["payments", id], queryFn: mocks.read }),
  orderCodQueryOptions: (id: string) => ({ queryKey: ["cod", id], queryFn: mocks.read }),
}));
vi.mock("~/lib/api-mutations/orders", () => ({
  useUpdateOrderCod: () => ({ mutate: mocks.mutate, isPending: false }),
  useRefundOrder: () => ({ mutate: mocks.mutate, isPending: false }),
  useReconcileRefundAttempt: () => ({ mutate: mocks.mutate, isPending: false }),
  useIssueOrderPaymentRecoveryLink: () => ({ mutateAsync: mocks.issue, isPending: false }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const order: Order = {
  id: "order_history", version: 1, customerName: "Test buyer", customerPhone: "+8801700000000",
  customerEmail: null, shippingAddress: "Test address", city: "Dhaka", zone: "Central Road",
  area: null, notes: null, discountAmount: 0, shippingCharge: 0, status: "incomplete",
  createdAt: 1_783_000_000, updatedAt: 1_783_000_000, items: [], totalAmount: 1800,
  customerId: null, paymentMethod: "sslcommerz", paymentStatus: "failed", paidAmount: 0,
  balanceDue: 1800, fullEditReadiness: { allowed: false, reason: null },
};
type SessionAttempt = OrderPaymentsPayload["paymentSessionAttempts"][number];
const attempt: SessionAttempt = {
  id: "attempt_history", orderId: order.id, gateway: "sslcommerz", paymentType: "full",
  amount: 1800, currency: "BDT", status: "failed", attempts: 1,
  providerSessionId: null, providerCorrelationId: null, lastError: null, claimExpiresAt: null,
  createdAt: 1_783_000_000, updatedAt: 1_783_000_060, activeProcessing: false, staleProcessing: false,
};
const recovery = {
  state: "needs_attention" as const, label: "Payment needs attention", message: "Buyer verification is available.",
  gateway: "sslcommerz", paymentType: "full", status: "failed", attempts: 1,
  activeProcessing: false, staleProcessing: false, updatedAt: null,
};

describe("PaymentCard session history", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canEdit = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    act(() => root.unmount());
    client.clear();
    host.remove();
    vi.restoreAllMocks();
  });

  async function render(session: Partial<SessionAttempt>, overrides: Partial<Order> = {}) {
    const payments: OrderPaymentsPayload = {
      payments: [], plan: null, refundAttempts: [], activeRefundOperation: null,
      paymentWebhookIssues: [], paymentSessionAttempts: [{ ...attempt, ...session }],
    };
    client.setQueryData(["payments", order.id], payments);
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <PaymentCard order={{ ...order, ...overrides }} />
      </QueryClientProvider>,
    ));
    expect(mocks.read).not.toHaveBeenCalled();
  }

  function history() {
    return Array.from(host.querySelectorAll("div"))
      .find((element) => element.textContent === "Payment session attempts")!.parentElement!.parentElement!;
  }

  function recoveryButton() {
    return Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Copy verification link");
  }

  it.each([
    { gateway: "stripe", providerSessionId: null, attempts: 1, lastError: "Gateway configuration is unavailable." },
    { gateway: "sslcommerz", providerSessionId: "hosted_cancelled", attempts: 1, lastError: "Hosted payment was cancelled before completion." },
    { gateway: "polar", providerSessionId: "retained_before_reclaim", attempts: 2, lastError: "Gateway session request failed." },
  ])("describes failed $gateway attempts without guessing the failure stage", async (session) => {
    await render({ ...session, providerCorrelationId: "correlation_recorded" }, {
      status: "cancelled", paymentMethod: session.gateway,
    });
    const content = history();
    expect(content.textContent).toContain("Payment attempt unsuccessful");
    expect(content.textContent).toContain("Review the recorded reason and gateway details.");
    expect(content.textContent).toContain(session.lastError);
    expect(content.textContent).not.toMatch(/setup failed|stopped before|can retry|can reuse/i);
    const details = content.querySelector("details")!;
    expect(details.querySelector("summary")?.textContent).toContain("Technical details");
    expect(details.textContent).toContain("correlation_recorded");
    if (session.providerSessionId) expect(details.textContent).toContain(session.providerSessionId);
    expect(recoveryButton()).toBeUndefined();
  });

  describe.each(["stripe", "sslcommerz", "polar"])("%s created sessions", (gateway) => {
    it.each([
      { status: "cancelled", paymentStatus: "failed", paidAmount: 0 },
      { status: "delivered", paymentStatus: "paid", paidAmount: 1800 },
      { status: "refunded", paymentStatus: "refunded", paidAmount: 0 },
    ])("does not attribute the order's $paymentStatus outcome to this attempt", async (state) => {
      await render({ gateway, status: "created", providerSessionId: "session_recorded" }, { ...state, paymentMethod: gateway });
      const content = history();
      expect(content.textContent).toContain(gateway === "stripe" ? "Card payment created" : "Hosted session created");
      expect(content.querySelector("p")?.textContent).toBe(gateway === "stripe"
        ? "The gateway created a card payment request."
        : "The gateway created a hosted payment session.");
      expect(content.textContent).not.toMatch(/retry|reuse|completed|refunded/i);
      expect(recoveryButton()).toBeUndefined();
    });
  });

  it.each(["stripe", "sslcommerz", "polar"])("describes stale %s processing without promising retry", async (gateway) => {
    await render({ gateway, status: "processing", staleProcessing: true, claimExpiresAt: 1_783_000_030 }, {
      status: "cancelled", paymentMethod: gateway,
    });
    const content = history();
    expect(content.textContent).toContain("Checkout preparation unfinished");
    expect(content.querySelector("p")?.textContent).toBe("The session request did not finish within its processing window. Review the recorded details.");
    expect(content.textContent).not.toMatch(/retry|reclaim|payment failed/i);
    expect(content.querySelector("details")?.textContent).toContain("Lease until");
    expect(recoveryButton()).toBeUndefined();
  });

  it("retains the active-processing presentation and server recovery decision", async () => {
    await render({ status: "processing", activeProcessing: true }, {
      paymentRecovery: { ...recovery, state: "processing", activeProcessing: true, canIssueRecoveryLink: false },
    });
    expect(history().textContent).toContain("Preparing checkout");
    expect(history().querySelector("p")?.textContent).toBe("The gateway session request is still inside its processing window.");
    expect(recoveryButton()).toBeUndefined();
  });

  it.each([true, false])("honors the server recovery decision %s for failed hosted history", async (allowed) => {
    await render({ lastError: "Hosted payment was cancelled before completion." }, {
      paymentRecovery: { ...recovery, canIssueRecoveryLink: allowed },
    });
    expect(Boolean(recoveryButton())).toBe(allowed);
    if (allowed) {
      const url = "https://shop.example.test/payment-recovery?orderId=order_history";
      mocks.issue.mockResolvedValueOnce({ url, note: "Verify the order contact to continue." });
      const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValueOnce();
      await act(async () => recoveryButton()!.click());
      expect(mocks.issue).toHaveBeenCalledWith({ orderId: order.id });
      expect(copy).toHaveBeenCalledWith(url);
    } else {
      expect(mocks.issue).not.toHaveBeenCalled();
    }
  });

  it("keeps recovery unavailable to a view-only merchant", async () => {
    mocks.canEdit = false;
    await render({}, { paymentRecovery: { ...recovery, canIssueRecoveryLink: true } });
    expect(history().textContent).toContain("failed");
    expect(recoveryButton()).toBeUndefined();
    expect(mocks.issue).not.toHaveBeenCalled();
  });
});
