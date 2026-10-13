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
        attempts: 1,
        error: "Cannot pay a cancelled order",
        internalOnly: "not surfaced",
      }),
      processedAt: new Date("2026-06-28T00:00:00.000Z"),
    });

    expect(issue).toMatchObject({
      status: "manual_reconciliation",
      reason: "manual_reconciliation",
      message: "Payment webhook needs manual reconciliation: Cannot pay a cancelled order",
      error: "Cannot pay a cancelled order",
    });
    expect(JSON.stringify(issue)).not.toContain("internalOnly");
  });

  it("uses dead-letter copy for a payment event whose retries are spent", () => {
    const issue = formatPaymentWebhookIssue({
      id: "stripe:payment_intent.succeeded:evt_dlq",
      provider: "stripe",
      eventType: "payment_intent.succeeded",
      status: "failed",
      result: JSON.stringify({ reason: "retries_exhausted", attempts: 6, error: "D1 batch failed" }),
      processedAt: 1_900,
    });

    expect(issue.status).toBe("failed");
    expect(issue.reason).toBe("dead_letter");
    expect(issue.message).toContain("failed after every retry");
    expect(issue.error).toBe("D1 batch failed");
  });

  it("falls back safely when a result is plain text", () => {
    const issue = formatPaymentWebhookIssue({
      id: "sslcommerz:ipn:evt_1",
      provider: "sslcommerz",
      eventType: "ipn",
      status: "failed",
      result: "validation unavailable",
      processedAt: 1_900,
    });

    expect(issue.reason).toBe("failed");
    expect(issue.message).toBe("Payment webhook processing failed: validation unavailable");
    expect(issue.error).toBe("validation unavailable");
  });
});
