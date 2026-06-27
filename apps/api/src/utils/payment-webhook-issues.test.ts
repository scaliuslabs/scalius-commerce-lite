import { describe, expect, it } from "vitest";
import { formatPaymentWebhookIssue } from "./payment-webhook-issues";

describe("formatPaymentWebhookIssue", () => {
  it("summarizes manual reconciliation without exposing raw result blobs", () => {
    const issue = formatPaymentWebhookIssue({
      id: "stripe:payment_intent.succeeded:evt_1",
      provider: "stripe",
      eventType: "payment_intent.succeeded",
      status: "manual_reconciliation",
      result: JSON.stringify({
        queueType: "payment.stripe.confirmed",
        queueMessageId: "msg_1",
        error: "Cannot pay a cancelled order",
        internalOnly: "not surfaced",
      }),
      processedAt: new Date("2026-06-28T00:00:00.000Z"),
    });

    expect(issue).toMatchObject({
      status: "manual_reconciliation",
      message: "Payment webhook needs manual reconciliation: Cannot pay a cancelled order",
      error: "Cannot pay a cancelled order",
      queueType: "payment.stripe.confirmed",
      queueMessageId: "msg_1",
    });
    expect(JSON.stringify(issue)).not.toContain("internalOnly");
  });

  it("uses recovery copy for stale queued payment webhooks", () => {
    const issue = formatPaymentWebhookIssue({
      id: "sslcommerz:ipn:tran:val",
      provider: "sslcommerz",
      eventType: "ipn",
      status: "failed",
      result: JSON.stringify({
        reason: "stale_queued_payment_webhook",
        cutoffSeconds: 1_800,
      }),
      processedAt: 1_900,
    });

    expect(issue.status).toBe("failed");
    expect(issue.message).toContain("did not finish within six hours");
    expect(issue.error).toBeNull();
  });

  it("uses dead-letter queue copy for exhausted payment webhook deliveries", () => {
    const issue = formatPaymentWebhookIssue({
      id: "stripe:payment_intent.succeeded:evt_dlq",
      provider: "stripe",
      eventType: "payment_intent.succeeded",
      status: "failed",
      result: JSON.stringify({
        reason: "payment_events_dlq",
        queueType: "payment.stripe.confirmed",
        queueMessageId: "msg_dlq",
      }),
      processedAt: 1_900,
    });

    expect(issue.status).toBe("failed");
    expect(issue.message).toContain("dead-letter queue");
    expect(issue.queueType).toBe("payment.stripe.confirmed");
    expect(issue.queueMessageId).toBe("msg_dlq");
  });

  it("falls back safely when legacy failed rows store plain text", () => {
    const issue = formatPaymentWebhookIssue({
      id: "polar:order.paid:evt_1",
      provider: "polar",
      eventType: "order.paid",
      status: "failed",
      result: "Queue not available",
      processedAt: 1_900,
    });

    expect(issue.message).toBe("Payment webhook processing failed: Queue not available");
    expect(issue.error).toBe("Queue not available");
  });
});
