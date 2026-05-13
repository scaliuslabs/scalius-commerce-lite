import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(() => ({ id: "db" })),
  processPaymentConfirmed: vi.fn(),
  processPaymentFailed: vi.fn(),
  releaseOrderInventory: vi.fn(),
  processPolarWebhookRefund: vi.fn(),
  sendOrderNotificationEmail: vi.fn(),
  sendOrderNotification: vi.fn(),
  sendEmail: vi.fn(),
  handleOrderIngestBatch: vi.fn(),
  getDecimalPlaces: vi.fn(() => 2),
  getActiveSmsProvider: vi.fn(),
  getEncryptionKey: vi.fn(() => "test-key"),
}));

vi.mock("@scalius/database/client", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@scalius/core/modules/payments/process-payment", () => ({
  processPaymentConfirmed: mocks.processPaymentConfirmed,
  processPaymentFailed: mocks.processPaymentFailed,
  releaseOrderInventory: mocks.releaseOrderInventory,
}));

vi.mock("@scalius/core/modules/payments/polar", () => ({
  processPolarWebhookRefund: mocks.processPolarWebhookRefund,
}));

vi.mock("@scalius/core/modules/notifications/notifications.service", () => ({
  sendOrderNotificationEmail: mocks.sendOrderNotificationEmail,
  sendOrderNotification: mocks.sendOrderNotification,
}));

vi.mock("@scalius/core/integrations/email", () => ({
  sendEmail: mocks.sendEmail,
}));

vi.mock("@scalius/core/modules/orders/orders.queue", () => ({
  handleOrderIngestBatch: mocks.handleOrderIngestBatch,
}));

vi.mock("@scalius/shared/currency", () => ({
  getDecimalPlaces: mocks.getDecimalPlaces,
}));

vi.mock("@scalius/core/integrations/sms", () => ({
  getActiveSmsProvider: mocks.getActiveSmsProvider,
}));

vi.mock("./utils/encryption-key", () => ({
  getEncryptionKey: mocks.getEncryptionKey,
}));

import { handleQueueBatch, type PaymentQueueMessage } from "./queue-consumer";

function createMessage(body: PaymentQueueMessage): Message<PaymentQueueMessage> {
  return {
    id: `msg-${body.type}-${body.orderId}`,
    timestamp: new Date("2026-01-01T00:00:00Z"),
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function createBatch(messages: Array<Message<PaymentQueueMessage>>): MessageBatch<PaymentQueueMessage> {
  return {
    queue: "payment-events-queue",
    messages,
    metadata: {
      metrics: {
        backlogCount: messages.length,
        backlogBytes: 0,
        oldestMessageTimestamp: messages[0]?.timestamp,
      },
    },
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  };
}

describe("handleQueueBatch payment confirmation retries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  it("retries confirmed payment messages when processing returns an unsuccessful result", async () => {
    mocks.processPaymentConfirmed.mockResolvedValue({ success: false, error: "D1 batch failed" });

    const messages = [
      createMessage({
        type: "payment.stripe.confirmed",
        orderId: "order-stripe",
        paymentIntentId: "pi_123",
        amount: 12345,
        currency: "usd",
      }),
      createMessage({
        type: "payment.sslcommerz.confirmed",
        orderId: "order-ssl",
        tranId: "tran_123",
        valId: "val_123",
        bankTranId: "bank_123",
        amount: 1200,
        currency: "BDT",
      }),
      createMessage({
        type: "payment.polar.confirmed",
        orderId: "order-polar",
        checkoutId: "checkout_123",
        amount: 999,
        currency: "usd",
      }),
    ];

    await handleQueueBatch(createBatch(messages), {} as Env);

    expect(mocks.processPaymentConfirmed).toHaveBeenCalledTimes(3);
    for (const message of messages) {
      expect(message.ack).not.toHaveBeenCalled();
      expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    }
  });

  it("acks confirmed payment messages when processing succeeds", async () => {
    mocks.processPaymentConfirmed.mockResolvedValue({ success: true });

    const message = createMessage({
      type: "payment.stripe.confirmed",
      orderId: "order-stripe",
      paymentIntentId: "pi_123",
      amount: 12345,
      currency: "usd",
    });

    await handleQueueBatch(createBatch([message]), {} as Env);

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });
});
