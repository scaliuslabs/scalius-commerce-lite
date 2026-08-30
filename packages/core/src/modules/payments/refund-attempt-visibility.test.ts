import { describe, expect, it } from "vitest";
import {
  formatRefundAttemptForVisibility,
  resolveActiveRefundOperationsForOrders,
  summarizeActiveRefundOperation,
  type RefundAttemptVisibilityRow,
} from "./refund-attempt-visibility";

const row: RefundAttemptVisibilityRow = {
  id: "rfa_1",
  orderId: "order_1",
  sourcePaymentId: "pay_1",
  refundPaymentId: "refund_1",
  gateway: "stripe",
  amount: 50,
  currency: "BDT",
  reason: "requested_by_customer",
  refundReference: "refund_order_1_1",
  allocationIndex: 0,
  allocationCount: 1,
  sourceTransactionId: "ch_123",
  providerRefundId: "re_123",
  providerCorrelationId: "corr_123",
  providerStatus: "accepted",
  status: "reconcile_required",
  attempts: 2,
  nextProbeAt: 1_765_000_900,
  lastProbeAt: 1_765_000_000,
  lastError: "local CAS lost",
  refundedAt: null,
  failedAt: null,
  createdAt: 1_764_999_900,
  updatedAt: 1_765_000_000,
};

describe("refund attempt visibility", () => {
  it("keeps operational references in admin views", () => {
    const view = formatRefundAttemptForVisibility(row, "admin");

    expect(view).toMatchObject({
      status: "reconcile_required",
      providerStatus: "accepted",
      providerRefundId: "re_123",
      providerCorrelationId: "corr_123",
      sourceTransactionId: "ch_123",
      refundReference: "refund_order_1_1",
      reason: "requested_by_customer",
      refundPaymentId: "refund_1",
      sourcePaymentId: "pay_1",
      lastError: "local CAS lost",
      active: true,
    });
    expect(view.message).toContain("local order");
  });

  it("maps customer views to buyer-safe status and hides provider internals", () => {
    const view = formatRefundAttemptForVisibility(row, "customer");

    expect(view).toMatchObject({
      status: "processing",
      providerStatus: null,
      active: true,
    });
    expect(JSON.stringify(view)).not.toContain("reconcile_required");
    expect(JSON.stringify(view)).not.toContain("providerRefundId");
    expect(JSON.stringify(view)).not.toContain("providerCorrelationId");
    expect(JSON.stringify(view)).not.toContain("sourceTransactionId");
    expect(JSON.stringify(view)).not.toContain("refundReference");
    expect(JSON.stringify(view)).not.toContain("ch_123");
    expect(JSON.stringify(view)).not.toContain("corr_123");
    expect(JSON.stringify(view)).not.toContain("requested_by_customer");
    expect(JSON.stringify(view)).not.toContain("local CAS lost");
  });

  it("describes COD reconciliation as a confirmed manual settlement, not provider acceptance", () => {
    const manualRow: RefundAttemptVisibilityRow = {
      ...row,
      gateway: "cod",
      providerStatus: "manual_confirmed",
      providerRefundId: null,
      providerCorrelationId: null,
      sourceTransactionId: null,
    };

    const adminView = formatRefundAttemptForVisibility(manualRow, "admin");
    const customerView = formatRefundAttemptForVisibility(manualRow, "customer");

    expect(adminView.label).toBe("Manual refund recorded, local update pending");
    expect(adminView.message).toContain("confirmed outside Scalius");
    expect(adminView.message).not.toContain("provider accepted");
    expect(customerView.message).toContain("merchant recorded the manual refund");
  });

  it("summarizes active attempts without losing the customer-safe status", () => {
    const customerView = formatRefundAttemptForVisibility(row, "customer");
    const summary = summarizeActiveRefundOperation([customerView], "customer");

    expect(summary).toMatchObject({
      active: true,
      status: "processing",
      amount: 50,
      providerStatus: null,
    });
    expect(JSON.stringify(summary)).not.toContain("reconcile_required");
    expect(JSON.stringify(summary)).not.toContain("re_123");
    expect(JSON.stringify(summary)).not.toContain("corr_123");
    expect(JSON.stringify(summary)).not.toContain("ch_123");
  });

  it("resolves batched order-list rows into bounded operational summaries", () => {
    const operations = resolveActiveRefundOperationsForOrders([row]);

    expect(operations.get("order_1")).toMatchObject({
      active: true,
      status: "reconcile_required",
      amount: 50,
      attemptCount: 1,
    });
    expect(operations.get("order_1")).not.toHaveProperty("providerRefundId");
    expect(operations.get("order_1")).not.toHaveProperty("lastError");
  });
});
