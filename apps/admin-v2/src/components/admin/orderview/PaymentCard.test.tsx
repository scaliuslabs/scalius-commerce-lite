// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderPaymentsPayload } from "~/lib/api-query-options/orders";
import { setLocale } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import type { Order } from "./types";
import { PaymentCard } from "./PaymentCard";

const mocks = vi.hoisted(() => ({
  permissions: { canEditOrders: true, canRefundOrders: false, canUpdateOrderCod: false },
  issue: vi.fn(),
  mutate: vi.fn(),
  refund: vi.fn(),
  read: vi.fn(),
  cod: vi.fn(),
  refundPending: false,
}));

vi.mock("~/hooks/use-currency", () => ({ useCurrency: () => ({ symbol: "৳", fmt: (value: number) => `৳${value}` }) }));
vi.mock("~/lib/order-detail-prefetch", () => ({ ORDER_DETAIL_PREFETCH_STALE_MS: 30_000 }));
vi.mock("~/hooks/use-order-action-permissions", () => ({ useOrderActionPermissions: () => mocks.permissions }));
vi.mock("~/lib/api-query-options/orders", () => ({
  orderPaymentsQueryOptions: (id: string) => ({ queryKey: ["payments", id], queryFn: mocks.read }),
  orderCodQueryOptions: (id: string) => ({ queryKey: ["cod", id], queryFn: mocks.cod }),
}));
vi.mock("~/lib/api-mutations/orders", () => ({
  useUpdateOrderCod: () => ({ mutate: mocks.mutate, reset: vi.fn(), isPending: false }),
  useRefundOrder: () => ({ mutate: mocks.refund, reset: vi.fn(), isPending: mocks.refundPending }),
  orderErrorMessage: (error: Error) => error.message,
  isOrderConflict: (error: { status?: number }) => error?.status === 409,
  useReconcileRefundAttempt: () => ({ mutate: mocks.mutate, isPending: false }),
  useIssueOrderPaymentRecoveryLink: () => ({ mutateAsync: mocks.issue, isPending: false }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const en = orderDetailMessages.en;
const bn = orderDetailMessages.bn;

const order: Order = {
  id: "order_history", version: 1, customerName: "Test buyer", customerPhone: "+8801700000000",
  customerEmail: null, shippingAddress: "Test address", city: "Dhaka", zone: "Central Road",
  area: null, notes: null, discountAmount: 0, shippingCharge: 0, status: "incomplete",
  createdAt: 1_783_000_000, updatedAt: 1_783_000_000, items: [], totalAmount: 1800,
  customerId: null, paymentMethod: "sslcommerz", paymentStatus: "failed", paidAmount: 0,
  balanceDue: 1800, orderNumber: 1001, archivedAt: null, discounts: [], refundDue: 0, refundedAmount: 0,
  editReadiness: { items: { allowed: false, reason: "closed" }, details: { allowed: false, reason: "closed" } },
};
type SessionAttempt = OrderPaymentsPayload["paymentSessionAttempts"][number];
const attempt: SessionAttempt = {
  id: "attempt_history", orderId: order.id, gateway: "sslcommerz", paymentType: "full",
  amount: 1800, currency: "BDT", status: "failed", attempts: 1,
  providerSessionId: null, providerCorrelationId: null, lastError: null, claimExpiresAt: null,
  createdAt: 1_783_000_000, updatedAt: 1_783_000_060, activeProcessing: false, staleProcessing: false,
};
const recovery = {
  state: "needs_attention" as const,
  gateway: "sslcommerz", paymentType: "full", status: "failed", attempts: 1,
  activeProcessing: false, staleProcessing: false, updatedAt: null,
};
const emptyPayments: OrderPaymentsPayload = {
  payments: [], plan: null, refundAttempts: [], activeRefundOperation: null,
  paymentWebhookIssues: [], paymentSessionAttempts: [],
};

describe("PaymentCard", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.permissions = { canEditOrders: true, canRefundOrders: false, canUpdateOrderCod: false };
    mocks.refundPending = false;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    act(() => root.unmount());
    setLocale("en");
    client.clear();
    host.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  async function render(overrides: Partial<Order>, payments: OrderPaymentsPayload = emptyPayments) {
    client.setQueryData(["payments", overrides.id ?? order.id], payments);
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <PaymentCard order={{ ...order, ...overrides }} />
      </QueryClientProvider>,
    ));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  const renderSession = (session: Partial<SessionAttempt>, overrides: Partial<Order> = {}) =>
    render(overrides, { ...emptyPayments, paymentSessionAttempts: [{ ...attempt, ...session }] });

  const sessionRow = () => host.querySelector<HTMLElement>('[data-testid="session-attempt"]')!;
  const button = (label: string) =>
    [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);

  describe("payment attempts", () => {
    it.each([
      { gateway: "stripe", providerSessionId: null, lastError: "Gateway configuration is unavailable." },
      { gateway: "sslcommerz", providerSessionId: "hosted_cancelled", lastError: "Hosted payment was cancelled before completion." },
    ])("shows a failed $gateway attempt with its recorded reason", async (session) => {
      await renderSession({ ...session, providerCorrelationId: "correlation_recorded" }, {
        status: "cancelled", paymentMethod: session.gateway,
      });
      expect(mocks.read).not.toHaveBeenCalled();
      const row = sessionRow();
      expect(row.textContent).toContain(en["session.failed"]);
      expect(row.textContent).toContain(session.lastError);
      // Provider ids stay out of the merchant's view.
      expect(row.textContent).not.toContain("correlation_recorded");
      expect(button(en["recovery.copy"])).toBeUndefined();
    });

    it.each(["stripe", "sslcommerz"])("does not tie the order's outcome to a created %s session", async (gateway) => {
      await renderSession({ gateway, status: "created", providerSessionId: "session_recorded" }, {
        status: "delivered", paymentStatus: "paid", paidAmount: 1800, paymentMethod: gateway,
      });
      expect(sessionRow().textContent).toContain(gateway === "stripe" ? en["session.cardStarted"] : en["session.pageOpened"]);
      expect(sessionRow().textContent).not.toMatch(/retry|reuse|completed|refunded/i);
    });

    it("shows unfinished processing with its expiry", async () => {
      await renderSession({ status: "processing", staleProcessing: true, claimExpiresAt: 1_783_000_030 }, { status: "cancelled" });
      expect(sessionRow().textContent).toContain(en["session.unfinished"]);
      expect(sessionRow().textContent).toContain(en["session.expires"].replace(" {date}", ""));
    });

    it("keeps the server's no-link decision while payment is processing", async () => {
      await renderSession({ status: "processing", activeProcessing: true }, {
        paymentRecovery: { ...recovery, state: "processing", activeProcessing: true, canIssueRecoveryLink: false },
      });
      expect(sessionRow().textContent).toContain(en["session.processingHelp"]);
      expect(button(en["recovery.copy"])).toBeUndefined();
    });

    it.each([true, false])("honors the server payment-link decision %s", async (allowed) => {
      await renderSession({}, { paymentRecovery: { ...recovery, canIssueRecoveryLink: allowed } });
      expect(Boolean(button(en["recovery.copy"]))).toBe(allowed);
      if (!allowed) return;
      const url = "https://shop.example.test/payment-recovery?orderId=order_history";
      mocks.issue.mockResolvedValueOnce({ url, note: "Verify the order contact to continue." });
      const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValueOnce();
      await act(async () => button(en["recovery.copy"])!.click());
      expect(mocks.issue).toHaveBeenCalledWith({ orderId: order.id });
      expect(copy).toHaveBeenCalledWith(url);
    });

    it("hides the payment link from a view-only merchant", async () => {
      mocks.permissions.canEditOrders = false;
      await renderSession({}, { paymentRecovery: { ...recovery, canIssueRecoveryLink: true } });
      expect(button(en["recovery.copy"])).toBeUndefined();
    });
  });

  it("summarises a partial refund as paid, refunded and net, with its own badge", async () => {
    await render({
      id: "order_refund", status: "delivered", paymentMethod: "stripe", paymentStatus: "partially_refunded",
      paidAmount: 1300, refundedAmount: 500, balanceDue: 0,
    });
    const rows = [...host.querySelectorAll("dl div")].map((row) => row.textContent);
    expect(rows).toContain(`${en["payment.refunded"]}−৳500`);
    expect(rows).toContain(`${en["payment.net"]}৳1300`);
    expect(rows.some((row) => row?.startsWith(en["payment.balanceDue"]))).toBe(false);
    expect(host.textContent).toContain("Partially refunded");
    expect(host.textContent).not.toContain("Partly paid");
  });

  it("words refund states from the dashboard's own catalog, not the server's English", async () => {
    type RefundAttempt = OrderPaymentsPayload["refundAttempts"][number];
    const settled = {
      id: "refund_done", orderId: "order_refunded", amount: 500, currency: "BDT", gateway: "stripe",
      status: "refunded", providerStatus: "succeeded", active: false, severity: "success",
      label: "Refund completed", message: "The refund is complete and no longer blocks order actions.",
      createdAt: "2026-09-20T10:00:00.000Z", updatedAt: "2026-09-20T10:00:00.000Z", nextProbeAt: null,
      lastProbeAt: null, refundedAt: "2026-09-20T10:00:00.000Z", failedAt: null, reason: "requested_by_customer",
    } as RefundAttempt;
    const running = {
      ...settled, id: "refund_running", gateway: "cod", status: "reconcile_required", active: true,
      severity: "warning", refundedAt: null, label: "Manual refund recorded, local update pending",
      message: "The COD repayment was confirmed outside Scalius.",
    } as RefundAttempt;
    setLocale("bn");
    await render(
      { id: "order_refunded", status: "delivered", paymentMethod: "stripe", paymentStatus: "partially_refunded", paidAmount: 1300, refundedAmount: 500, balanceDue: 0 },
      { ...emptyPayments, refundAttempts: [running, settled] },
    );
    expect(host.textContent).toContain(bn["refundState.refunded"]);
    expect(host.textContent).toContain(bn["refundState.reconcile_required_cod"]);
    expect(host.textContent).not.toContain("Refund completed");
    expect(host.textContent).not.toContain("Manual refund recorded");
  });

  it("shows money still owed for returned items", async () => {
    await render({ id: "order_owed", status: "returned", paymentMethod: "stripe", paymentStatus: "paid", paidAmount: 2480, refundDue: 1600, balanceDue: 0 });
    const rows = [...host.querySelectorAll("dl div")].map((row) => row.textContent);
    expect(rows).toContain("Refund owed৳1600");
    // A returned order is closed: no payment badge.
    expect(host.querySelector("[data-slot='badge']")).toBeNull();
  });

  describe("cash on delivery", () => {
    const codOrder: Partial<Order> = {
      id: "order_cod", paymentMethod: "cod", status: "delivered", paymentStatus: "paid", paidAmount: 1800, balanceDue: 0,
    };

    it("pre-fills only what came back, as returned items, and records it after the merchant confirms the money was returned", async () => {
      mocks.permissions.canRefundOrders = true;
      mocks.cod.mockResolvedValue({ tracking: null });
      await render({ ...codOrder, refundDue: 600 });
      await act(async () => button(en["refund.recordCash"])!.click());

      const submit = [...document.querySelectorAll('[role="dialog"] button')]
        .find((candidate) => candidate.textContent === en["refund.recordCashAmount"].replace("{amount}", "৳600")) as HTMLButtonElement;
      expect(submit.disabled).toBe(true);
      expect(document.body.textContent).toContain(en["refund.manualConfirm"]);

      await act(async () => document.querySelector<HTMLButtonElement>("#manualSettlementConfirmed")!.click());
      expect(submit.disabled).toBe(false);
      await act(async () => submit.click());
      expect(mocks.refund).toHaveBeenCalledWith(
        { orderId: "order_cod", requestKey: expect.any(String), amount: 600, reason: "returned_items", manualSettlementConfirmed: true },
        expect.anything(),
      );
    });

    it("gives every opening of the refund dialog its own request key and submits with Enter", async () => {
      mocks.permissions.canRefundOrders = true;
      mocks.cod.mockResolvedValue({ tracking: null });
      await render({ ...codOrder, refundDue: 600 });
      const submitWithEnter = async () => {
        await act(async () => document.querySelector<HTMLButtonElement>("#manualSettlementConfirmed")!.click());
        // Enter in the amount field submits the dialog's form.
        await act(async () => {
          document.querySelector("#order-refund")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        });
      };

      await act(async () => button(en["refund.recordCash"])!.click());
      await submitWithEnter();
      await act(async () => button("Cancel")!.click());
      await act(async () => button(en["refund.recordCash"])!.click());
      await submitWithEnter();

      expect(mocks.refund).toHaveBeenCalledTimes(2);
      const [first, second] = mocks.refund.mock.calls.map(([payload]) => payload.requestKey);
      expect(first).toEqual(expect.any(String));
      expect(second).toEqual(expect.any(String));
      expect(second).not.toBe(first);
    });

    it("keeps the refund button busy while the refund is being recorded", async () => {
      mocks.permissions.canRefundOrders = true;
      mocks.cod.mockResolvedValue({ tracking: null });
      await render({ ...codOrder, refundDue: 600 });
      await act(async () => button(en["refund.recordCash"])!.click());
      mocks.refundPending = true;
      await render({ ...codOrder, refundDue: 600 });
      const submit = document.querySelector<HTMLButtonElement>('button[form="order-refund"]')!;
      expect(submit.disabled).toBe(true);
      expect(submit.getAttribute("aria-busy")).toBe("true");
      await act(async () => {
        document.querySelector("#order-refund")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      expect(mocks.refund).not.toHaveBeenCalled();
    });

    it("drops the old failed-delivery reason once the cash is collected", async () => {
      mocks.cod.mockResolvedValue({
        tracking: {
          codStatus: "collected", deliveryAttempts: 1, collectedBy: "Rider Karim", collectedAmount: 1800,
          failureReason: "no_cash", failureNote: "Will pay tomorrow",
        },
      });
      await render(codOrder);
      expect(host.textContent).toContain("Rider Karim");
      expect(host.textContent).not.toContain(en["cod.reason.no_cash"]);
      expect(host.textContent).not.toContain("Will pay tomorrow");
    });

    it("never pre-fills the full order and flags more than was paid next to the field", async () => {
      mocks.permissions.canRefundOrders = true;
      mocks.cod.mockResolvedValue({ tracking: null });
      await render(codOrder);
      await act(async () => button(en["refund.recordCash"])!.click());
      const amount = document.querySelector<HTMLInputElement>("#refundAmount")!;
      expect(amount.value).toBe("");

      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      await act(async () => {
        setter.call(amount, "3000");
        amount.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => document.querySelector<HTMLButtonElement>("#manualSettlementConfirmed")!.click());
      const submit = [...document.querySelectorAll('[role="dialog"] button')]
        .find((candidate) => candidate.textContent === en["refund.recordCash"]) as HTMLButtonElement;
      // An invalid amount is never echoed on the button (R3-ORD-16).
      expect(document.body.textContent).not.toContain(en["refund.recordCashAmount"].replace("{amount}", "৳3000"));
      await act(async () => submit.click());
      expect(mocks.refund).not.toHaveBeenCalled();
      expect(amount.getAttribute("aria-invalid")).toBe("true");
      expect(document.querySelector("#refundAmount-help")?.textContent).toBe(en["refund.amountInvalid"].replace("{amount}", "৳1800"));
    });

    it("takes a cash refund typed in Bangla digits", async () => {
      mocks.permissions.canRefundOrders = true;
      mocks.cod.mockResolvedValue({ tracking: null });
      await render(codOrder);
      await act(async () => button(en["refund.recordCash"])!.click());
      const amount = document.querySelector<HTMLInputElement>("#refundAmount")!;
      expect(amount.type).toBe("text");
      expect(amount.inputMode).toBe("decimal");

      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      await act(async () => {
        setter.call(amount, "\u09eb\u09e6\u09e6");
        amount.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(amount.value).toBe("\u09eb\u09e6\u09e6");
      await act(async () => document.querySelector<HTMLButtonElement>("#manualSettlementConfirmed")!.click());
      const submit = [...document.querySelectorAll('[role="dialog"] button')]
        .find((candidate) => candidate.textContent === en["refund.recordCashAmount"].replace("{amount}", "৳500")) as HTMLButtonElement;
      await act(async () => submit.click());
      expect(mocks.refund).toHaveBeenCalledWith(
        { orderId: "order_cod", requestKey: expect.any(String), amount: 500, reason: "requested_by_customer", manualSettlementConfirmed: true },
        expect.anything(),
      );
    });

    it("hides refunds from merchants without refund permission", async () => {
      mocks.cod.mockResolvedValue({ tracking: null });
      await render(codOrder);
      expect(button(en["refund.recordCash"])).toBeUndefined();
    });

    it("hides collection actions while cash collection can't be read", async () => {
      mocks.permissions.canUpdateOrderCod = true;
      mocks.cod.mockRejectedValue(new Error("offline"));
      await render({ ...codOrder, status: "shipped", paymentStatus: "unpaid", paidAmount: 0, balanceDue: 1800 });
      expect(host.textContent).toContain(en["cod.loadFailed"]);
      expect(button(en["cod.markCollected"])).toBeUndefined();
    });

    it("offers collection once the cash state is known", async () => {
      mocks.permissions.canUpdateOrderCod = true;
      mocks.cod.mockResolvedValue({ tracking: null });
      await render({ ...codOrder, status: "shipped", paymentStatus: "unpaid", paidAmount: 0, balanceDue: 1800 });
      expect(button(en["cod.markCollected"])).toBeDefined();
    });

    it("doesn't offer collecting cash before the order is sent", async () => {
      mocks.permissions.canUpdateOrderCod = true;
      mocks.cod.mockResolvedValue({ tracking: null });
      await render({ ...codOrder, status: "confirmed", paymentStatus: "unpaid", paidAmount: 0, balanceDue: 1800 });
      expect(button(en["cod.markCollected"])).toBeUndefined();
    });

    it("collects exactly the balance and asks who collected it", async () => {
      mocks.permissions.canUpdateOrderCod = true;
      mocks.cod.mockResolvedValue({ tracking: null });
      await render({ ...codOrder, status: "shipped", paymentStatus: "unpaid", paidAmount: 0, balanceDue: 1800 });
      await act(async () => button(en["cod.markCollected"])!.click());
      expect(document.querySelector("#collectedAmount")).toBeNull();
      const submit = button(en["cod.collectAmount"].replace("{amount}", "৳1800"))!;
      await act(async () => submit.click());
      expect(mocks.mutate).not.toHaveBeenCalled();
      expect(document.querySelector("#collectedBy-error")?.textContent).toBe(en["cod.collectorRequired"]);

      const input = document.querySelector<HTMLInputElement>("#collectedBy")!;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      await act(async () => {
        setter.call(input, "Rider Karim");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => submit.click());
      expect(mocks.mutate).toHaveBeenCalledWith(
        { orderId: "order_cod", action: "collected", collectedBy: "Rider Karim", collectedAmount: 1800 },
        expect.anything(),
      );
    });

    const riderParcel = (id: string, courierName: string, createdAt: number) => ({
      id, orderId: "order_cod", providerId: null, providerType: "manual", courierName, externalId: null,
      trackingId: null, status: "in_transit", rawStatus: null, createdAt,
    });

    it("pre-fills Collected by with the rider of the latest parcel, still editable (R3-ORD-08)", async () => {
      mocks.permissions.canUpdateOrderCod = true;
      mocks.cod.mockResolvedValue({ tracking: null });
      await render({
        ...codOrder, status: "shipped", paymentStatus: "unpaid", paidAmount: 0, balanceDue: 1800,
        shipments: [riderParcel("s1", "R3 Rider Jamal", 1_783_000_000), riderParcel("s2", "R3 Rider Kamal", 1_783_000_500)],
      });
      await act(async () => button(en["cod.markCollected"])!.click());
      const input = document.querySelector<HTMLInputElement>("#collectedBy")!;
      expect(input.value).toBe("R3 Rider Kamal");
      expect(input.disabled).toBe(false);
      await act(async () => button(en["cod.collectAmount"].replace("{amount}", "৳1800"))!.click());
      expect(mocks.mutate).toHaveBeenCalledWith(
        { orderId: "order_cod", action: "collected", collectedBy: "R3 Rider Kamal", collectedAmount: 1800 },
        expect.anything(),
      );
    });

    it("closes the collect dialog without success when another tab already collected (R3-ORD-10)", async () => {
      mocks.permissions.canUpdateOrderCod = true;
      mocks.cod.mockResolvedValue({ tracking: null });
      mocks.mutate.mockImplementationOnce((_body, options: { onError?: (error: unknown) => void }) => {
        options.onError?.({ status: 409, message: "Cash for this order was already recorded as collected by Kamal." });
      });
      await render({
        ...codOrder, status: "shipped", paymentStatus: "unpaid", paidAmount: 0, balanceDue: 1800,
        shipments: [riderParcel("s1", "R3 Rider Kamal", 1_783_000_000)],
      });
      await act(async () => button(en["cod.markCollected"])!.click());
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      await act(async () => button(en["cod.collectAmount"].replace("{amount}", "৳1800"))!.click());
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    });

    it("offers Record failed delivery, not collection, on a part-sent order (R3-ORD-04)", async () => {
      mocks.permissions.canUpdateOrderCod = true;
      mocks.cod.mockResolvedValue({ tracking: null });
      await render({
        ...codOrder, status: "confirmed", paymentStatus: "unpaid", paidAmount: 0, balanceDue: 1800,
        items: [{ id: "i1", quantity: 2, fulfillmentType: "ship", fulfilledQuantity: 1 }] as Order["items"],
      });
      expect(button(en["cod.recordFailure"])).toBeDefined();
      expect(button(en["cod.markCollected"])).toBeUndefined();
    });
  });
});
