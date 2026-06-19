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
  invalidateProductAvailabilityCaches: vi.fn(),
  getAdminNotificationChannels: vi.fn(),
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

vi.mock("./utils/cache-invalidation", () => ({
  invalidateProductAvailabilityCaches: mocks.invalidateProductAvailabilityCaches,
}));

vi.mock("@scalius/core/modules/settings/settings.service", () => ({
  getAdminNotificationChannels: mocks.getAdminNotificationChannels,
}));

import { handleQueueBatch, type PaymentQueueMessage } from "./queue-consumer";
import type { OrderIngestQueueMessage } from "@scalius/core/modules/orders/orders.queue";

function createMessage(body: PaymentQueueMessage): Message<PaymentQueueMessage>;
function createMessage(body: OrderIngestQueueMessage): Message<OrderIngestQueueMessage>;
function createMessage<T>(body: T): Message<T>;
function createMessage<T>(body: T): Message<T> {
  const record = body as Record<string, unknown>;
  return {
    id: `msg-${String(record.type)}-${String(record.orderId ?? "no-order")}`,
    timestamp: new Date("2026-01-01T00:00:00Z"),
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function createBatch<T>(
  messages: Array<Message<T>>,
  queue = "payment-events-queue",
): MessageBatch<T> {
  return {
    queue,
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

function createOrderMessage(orderId: string): Message<OrderIngestQueueMessage> {
  const body: OrderIngestQueueMessage = {
    type: "order.ingest",
    checkoutToken: `chk_${orderId}`,
    existingCustomer: null,
    orderData: {
      id: orderId,
      customerName: "Queue Customer",
      customerPhone: "01700000000",
      customerEmail: null,
      shippingAddress: "123 Queue Street",
      city: "city_1",
      zone: "zone_1",
      area: null,
      cityName: "City",
      zoneName: "Zone",
      areaName: null,
      notes: null,
      totalAmount: 100,
      shippingCharge: 0,
      discountAmount: 0,
      status: "pending",
      paymentMethod: "cod",
      paymentStatus: "unpaid",
      paidAmount: 0,
      balanceDue: 100,
      fulfillmentStatus: "pending",
      inventoryPool: "regular",
      inventoryAction: "reserved",
    },
    items: [],
    discountUsage: null,
    requestUrl: "http://localhost/api/v1/orders",
  };
  return createMessage(body);
}

describe("handleQueueBatch payment confirmation retries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.getAdminNotificationChannels.mockResolvedValue({});
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
    expect(mocks.invalidateProductAvailabilityCaches).toHaveBeenCalledWith(
      { id: "db" },
      { orderIds: ["order-stripe"] },
      { env: {}, executionCtx: undefined },
    );
  });

  it("acks non-retryable confirmed payment guard failures", async () => {
    mocks.processPaymentConfirmed.mockResolvedValue({
      success: false,
      error: "Cannot pay a cancelled order",
      retryable: false,
    });

    const message = createMessage({
      type: "payment.stripe.confirmed",
      orderId: "order-stripe",
      paymentIntentId: "pi_late",
      amount: 12345,
      currency: "usd",
    });

    await handleQueueBatch(createBatch([message]), {} as Env);

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("requires manual reconciliation"),
    );
  });

  it("routes the configured order-ingest queue to the order ingest handler", async () => {
    const message = createOrderMessage("order_1");

    await handleQueueBatch(
      createBatch([message], "order-ingest") as never,
      {} as Env,
    );

    expect(mocks.handleOrderIngestBatch).toHaveBeenCalledTimes(1);
    expect(mocks.handleOrderIngestBatch.mock.calls[0]?.[0]).toMatchObject({
      queue: "order-ingest",
    });
    expect(mocks.invalidateProductAvailabilityCaches).toHaveBeenCalledWith(
      { id: "db" },
      { orderIds: ["order_1"], variantIds: [] },
      { env: {}, executionCtx: undefined },
    );
  });

  it("does not cast a mixed non-order queue to order ingest", async () => {
    mocks.processPaymentConfirmed.mockResolvedValue({ success: true });
    const payment = createMessage({
      type: "payment.stripe.confirmed",
      orderId: "order-stripe",
      paymentIntentId: "pi_123",
      amount: 12345,
      currency: "usd",
    });
    const strayOrder = createOrderMessage("order_stray");

    await handleQueueBatch(
      createBatch([payment, strayOrder] as Array<Message<Record<string, unknown>>>) as never,
      {} as Env,
    );

    expect(mocks.handleOrderIngestBatch).not.toHaveBeenCalled();
    expect(mocks.processPaymentConfirmed).toHaveBeenCalledTimes(1);
  });

  it("dispatches order notifications without requiring customer email and passes encryption key", async () => {
    const message = createMessage({
      type: "order.notification",
      orderId: "order-refunded",
      customerName: "SMS Customer",
      notificationType: "order_refunded",
      data: { reason: "refund" },
    });

    await handleQueueBatch(createBatch([message]), {
      CREDENTIAL_ENCRYPTION_KEY: "credential-key",
    } as Env);

    expect(mocks.getEncryptionKey).toHaveBeenCalledTimes(1);
    expect(mocks.sendOrderNotificationEmail).toHaveBeenCalledWith(
      undefined,
      "SMS Customer",
      "order-refunded",
      "order_refunded",
      { reason: "refund" },
      { id: "db" },
      {
        encryptionKey: "test-key",
        env: {
          CREDENTIAL_ENCRYPTION_KEY: "credential-key",
        },
      },
    );
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it("passes notification type to admin push dispatch when push is enabled", async () => {
    mocks.getAdminNotificationChannels.mockResolvedValue({
      order_shipped: ["push"],
    });
    const message = createMessage({
      type: "order.notification",
      orderId: "order-shipped",
      customerName: "Push Customer",
      notificationType: "order_shipped",
      data: { trackingId: "TRK-1" },
    });

    await handleQueueBatch(createBatch([message]), {
      PUBLIC_API_BASE_URL: "https://api.example.test",
    } as Env);

    expect(mocks.sendOrderNotification).toHaveBeenCalledWith(
      { id: "db" },
      {
        id: "order-shipped",
        customerName: "Push Customer",
        notificationType: "order_shipped",
      },
      { PUBLIC_API_BASE_URL: "https://api.example.test" },
      "https://api.example.test",
    );
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it("passes env and encryption context to OTP email dispatch", async () => {
    const message = createMessage({
      type: "auth.send_otp",
      method: "email",
      allowedMethod: "email",
      identifier: "buyer@example.com",
      code: "123456",
      name: "Buyer",
    } as const);
    const env = {
      EMAIL: {
        send: vi.fn(),
      },
      CREDENTIAL_ENCRYPTION_KEY: "credential-key",
    } as unknown as Env;

    await handleQueueBatch(createBatch([message]), env);

    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "buyer@example.com",
        subject: "Your login code",
        text: "Your login code is: 123456\n\nExpires in 5 minutes.",
      }),
      {
        db: { id: "db" },
        env,
        encryptionKey: "test-key",
      },
    );
    expect(message.ack).toHaveBeenCalledTimes(1);
  });
});
