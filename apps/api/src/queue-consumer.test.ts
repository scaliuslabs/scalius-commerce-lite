import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(() => ({ id: "db" })),
  processPaymentConfirmed: vi.fn(),
  processPaymentFailed: vi.fn(),
  releaseOrderInventory: vi.fn(),
  processPolarWebhookRefund: vi.fn(),
  sendOrderNotificationEmail: vi.fn(),
  sendOrderNotification: vi.fn(),
  sendEmail: vi.fn(),
  getWhatsAppCloudApiSettings: vi.fn(),
  sendWhatsAppTemplateMessage: vi.fn(),
  handleOrderIngestBatch: vi.fn(),
  getDecimalPlaces: vi.fn(() => 2),
  getActiveSmsProvider: vi.fn(),
  getEncryptionKey: vi.fn(() => "test-key"),
  getCredentialEncryptionKey: vi.fn(() => "credential-key"),
  invalidateProductAvailabilityCaches: vi.fn(),
  enqueueOrderCreatedNotificationForOrder: vi.fn(),
  getAdminNotificationChannels: vi.fn(),
  claimOrderNotificationOutboxForProcessing: vi.fn(),
  markOrderNotificationOutboxProcessingFailed: vi.fn(),
  markOrderNotificationOutboxSent: vi.fn(),
  createAuthOtpDeliveryTarget: vi.fn(),
  claimAuthOtpDeliveryReceipt: vi.fn(),
  markAuthOtpDeliveryReceiptAccepted: vi.fn(),
  markAuthOtpDeliveryReceiptFailed: vi.fn(),
  markAuthOtpDeliveryReceiptSkipped: vi.fn(),
  createAuthOtpProviderClientReference: vi.fn(() => "otpclientref1"),
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

vi.mock("@scalius/core/modules/notifications", () => ({
  claimOrderNotificationOutboxForProcessing: mocks.claimOrderNotificationOutboxForProcessing,
  markOrderNotificationOutboxProcessingFailed: mocks.markOrderNotificationOutboxProcessingFailed,
  markOrderNotificationOutboxSent: mocks.markOrderNotificationOutboxSent,
}));

vi.mock("@scalius/core/modules/customers/otp-delivery-receipts", () => ({
  createAuthOtpDeliveryTarget: mocks.createAuthOtpDeliveryTarget,
  claimAuthOtpDeliveryReceipt: mocks.claimAuthOtpDeliveryReceipt,
  markAuthOtpDeliveryReceiptAccepted: mocks.markAuthOtpDeliveryReceiptAccepted,
  markAuthOtpDeliveryReceiptFailed: mocks.markAuthOtpDeliveryReceiptFailed,
  markAuthOtpDeliveryReceiptSkipped: mocks.markAuthOtpDeliveryReceiptSkipped,
  createAuthOtpProviderClientReference: mocks.createAuthOtpProviderClientReference,
}));

vi.mock("@scalius/core/integrations/email", () => ({
  sendEmail: mocks.sendEmail,
}));

vi.mock("@scalius/core/integrations/whatsapp", () => ({
  getWhatsAppCloudApiSettings: mocks.getWhatsAppCloudApiSettings,
  sendWhatsAppTemplateMessage: mocks.sendWhatsAppTemplateMessage,
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
  getCredentialEncryptionKey: mocks.getCredentialEncryptionKey,
}));

vi.mock("./utils/cache-invalidation", () => ({
  invalidateProductAvailabilityCaches: mocks.invalidateProductAvailabilityCaches,
}));

vi.mock("./utils/order-notification-queue", () => ({
  enqueueOrderCreatedNotificationForOrder: mocks.enqueueOrderCreatedNotificationForOrder,
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
    mocks.sendOrderNotificationEmail.mockResolvedValue(undefined);
    mocks.sendOrderNotification.mockResolvedValue(undefined);
    mocks.sendEmail.mockResolvedValue({
      success: true,
      provider: "cloudflare",
      providerRef: "cf_msg_1",
      rawStatus: "accepted",
    });
    mocks.getWhatsAppCloudApiSettings.mockResolvedValue({
      accessToken: "wa_token",
      accessTokenConfigured: true,
      phoneNumberId: "phone_id_1",
      authTemplateName: "auth_otp",
      accessTokenSource: "encrypted",
    });
    mocks.sendWhatsAppTemplateMessage.mockResolvedValue({
      success: true,
      providerRef: "wamid.otp.1",
      rawStatus: "accepted",
      rawResponse: JSON.stringify({ messageId: "wamid.otp.1", messageStatus: "accepted" }),
    });
    mocks.getActiveSmsProvider.mockResolvedValue(null);
    mocks.getAdminNotificationChannels.mockResolvedValue({});
    mocks.enqueueOrderCreatedNotificationForOrder.mockResolvedValue({
      orderId: "order_1",
      outboxId: "outbox_order_1",
      enqueued: true,
    });
    mocks.claimOrderNotificationOutboxForProcessing.mockResolvedValue({
      claimed: true,
      outboxId: "outbox_1",
      claimId: "claim_1",
      attempts: 2,
    });
    mocks.markOrderNotificationOutboxProcessingFailed.mockResolvedValue(undefined);
    mocks.markOrderNotificationOutboxSent.mockResolvedValue(undefined);
    mocks.createAuthOtpDeliveryTarget.mockImplementation(async (input) => ({
      ...input,
      purpose: input.purpose ?? "customer_login",
      identifierHash: "recipient_hash_1",
      identifierMasked: "b***@example.com",
      otpExpiresAt: input.otpExpiresAt ?? null,
    }));
    mocks.claimAuthOtpDeliveryReceipt.mockResolvedValue({
      claimed: true,
      receipt: {
        id: "aor_1",
        deliveryKey: "otp_delivery_1",
        claimId: "aorc_1",
        attempts: 1,
      },
    });
    mocks.markAuthOtpDeliveryReceiptAccepted.mockResolvedValue(undefined);
    mocks.markAuthOtpDeliveryReceiptFailed.mockResolvedValue(undefined);
    mocks.markAuthOtpDeliveryReceiptSkipped.mockResolvedValue(undefined);
    mocks.createAuthOtpProviderClientReference.mockReturnValue("otpclientref1");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
    const notificationQueue = { send: vi.fn(async () => undefined) };

    const message = createMessage({
      type: "payment.stripe.confirmed",
      orderId: "order-stripe",
      paymentIntentId: "pi_123",
      amount: 12345,
      currency: "usd",
    });

    await handleQueueBatch(createBatch([message]), {
      ORDER_NOTIFICATIONS_QUEUE: notificationQueue,
    } as unknown as Env);

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
    expect(mocks.invalidateProductAvailabilityCaches).toHaveBeenCalledWith(
      { id: "db" },
      { orderIds: ["order-stripe"] },
      { env: { ORDER_NOTIFICATIONS_QUEUE: notificationQueue }, executionCtx: undefined },
    );
    expect(mocks.enqueueOrderCreatedNotificationForOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        db: { id: "db" },
        queue: notificationQueue,
        orderId: "order-stripe",
        source: "payment-stripe-confirmed",
        retryOnQueueFailure: true,
      }),
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
    expect(mocks.enqueueOrderCreatedNotificationForOrder).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("requires manual reconciliation"),
    );
  });

  it("retries confirmed payment messages when order-created notification enqueue fails", async () => {
    mocks.processPaymentConfirmed.mockResolvedValue({ success: true });
    mocks.enqueueOrderCreatedNotificationForOrder.mockRejectedValue(new Error("queue unavailable"));

    const message = createMessage({
      type: "payment.sslcommerz.confirmed",
      orderId: "order-ssl",
      tranId: "tran_123",
      valId: "val_123",
      bankTranId: "bank_123",
      amount: 1200,
      currency: "BDT",
    });

    await handleQueueBatch(createBatch([message]), {} as Env);

    expect(mocks.processPaymentConfirmed).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateProductAvailabilityCaches).toHaveBeenCalledWith(
      { id: "db" },
      { orderIds: ["order-ssl"] },
      { env: {}, executionCtx: undefined },
    );
    expect(mocks.enqueueOrderCreatedNotificationForOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "order-ssl",
        source: "payment-sslcommerz-confirmed",
        retryOnQueueFailure: true,
      }),
    );
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
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

    expect(mocks.getEncryptionKey).not.toHaveBeenCalled();
    expect(mocks.getCredentialEncryptionKey).toHaveBeenCalledTimes(2);
    expect(mocks.sendOrderNotificationEmail).toHaveBeenCalledWith(
      undefined,
      "SMS Customer",
      "order-refunded",
      "order_refunded",
      { reason: "refund" },
      { id: "db" },
      {
        encryptionKey: "credential-key",
        migrationEncryptionKey: "credential-key",
        env: {
          CREDENTIAL_ENCRYPTION_KEY: "credential-key",
        },
        outboxId: undefined,
      },
    );
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it("claims and marks durable order notifications sent", async () => {
    const message = createMessage({
      type: "order.notification",
      outboxId: "outbox_order_shipped",
      orderId: "order-shipped",
      customerName: "Outbox Customer",
      notificationType: "order_shipped",
    });

    await handleQueueBatch(createBatch([message]), {} as Env);

    expect(mocks.claimOrderNotificationOutboxForProcessing).toHaveBeenCalledWith(
      { id: "db" },
      "outbox_order_shipped",
    );
    expect(mocks.sendOrderNotificationEmail).toHaveBeenCalledTimes(1);
    expect(mocks.markOrderNotificationOutboxSent).toHaveBeenCalledWith(
      { id: "db" },
      "outbox_1",
      "claim_1",
    );
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it("skips already-sent durable order notification messages", async () => {
    mocks.claimOrderNotificationOutboxForProcessing.mockResolvedValue({
      claimed: false,
      reason: "already_sent",
    });
    const message = createMessage({
      type: "order.notification",
      outboxId: "outbox_sent",
      orderId: "order-sent",
      customerName: "Sent Customer",
      notificationType: "order_delivered",
    });

    await handleQueueBatch(createBatch([message]), {} as Env);

    expect(mocks.sendOrderNotificationEmail).not.toHaveBeenCalled();
    expect(mocks.markOrderNotificationOutboxSent).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it("marks durable order notifications failed before queue retry when dispatch throws", async () => {
    mocks.sendOrderNotificationEmail.mockRejectedValue(new Error("email provider down"));
    const message = createMessage({
      type: "order.notification",
      outboxId: "outbox_fail",
      orderId: "order-fail",
      customerName: "Fail Customer",
      notificationType: "order_cancelled",
    });

    await handleQueueBatch(createBatch([message]), {} as Env);

    expect(mocks.markOrderNotificationOutboxProcessingFailed).toHaveBeenCalledWith(
      { id: "db" },
      "outbox_1",
      "claim_1",
      2,
      expect.any(Error),
    );
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
  });

  it("marks durable order notifications failed when receipt outcomes need retry", async () => {
    mocks.sendOrderNotificationEmail.mockResolvedValue({
      outcomes: [{
        channel: "email",
        provider: "cloudflare",
        recipientMasked: "b***@example.com",
        status: "failed",
        error: "provider timeout",
        retryable: true,
      }],
      hasRetryableFailure: true,
    });
    const message = createMessage({
      type: "order.notification",
      outboxId: "outbox_retry",
      orderId: "order-retry",
      customerName: "Retry Customer",
      notificationType: "order_created",
      customerEmail: "buyer@example.com",
    });

    await handleQueueBatch(createBatch([message]), {} as Env);

    expect(mocks.markOrderNotificationOutboxProcessingFailed).toHaveBeenCalledWith(
      { id: "db" },
      "outbox_1",
      "claim_1",
      2,
      expect.any(Error),
    );
    expect(mocks.markOrderNotificationOutboxSent).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
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
      { outboxId: undefined },
    );
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it("marks durable order notifications sent when admin push only has skipped receipts", async () => {
    mocks.getAdminNotificationChannels.mockResolvedValue({
      order_created: ["push"],
    });
    mocks.sendOrderNotification.mockResolvedValueOnce({
      outcomes: [{
        channel: "push",
        provider: "fcm",
        recipientMasked: "token:dead...oken",
        status: "skipped",
        providerStatus: "messaging/registration-token-not-registered",
        retryable: false,
      }],
      hasRetryableFailure: false,
    });
    const message = createMessage({
      type: "order.notification",
      outboxId: "outbox_admin_push_skipped",
      orderId: "order-admin-push-skipped",
      customerName: "Push Customer",
      notificationType: "order_created",
    });

    await handleQueueBatch(createBatch([message]), {
      PUBLIC_API_BASE_URL: "https://api.example.test",
    } as Env);

    expect(mocks.sendOrderNotification).toHaveBeenCalledWith(
      { id: "db" },
      {
        id: "order-admin-push-skipped",
        customerName: "Push Customer",
        notificationType: "order_created",
      },
      { PUBLIC_API_BASE_URL: "https://api.example.test" },
      "https://api.example.test",
      { outboxId: "outbox_admin_push_skipped" },
    );
    expect(mocks.markOrderNotificationOutboxSent).toHaveBeenCalledWith(
      { id: "db" },
      "outbox_1",
      "claim_1",
    );
    expect(mocks.markOrderNotificationOutboxProcessingFailed).not.toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it("passes env and encryption context to OTP email dispatch", async () => {
    const message = createMessage({
      type: "auth.send_otp",
      deliveryKey: "otp_delivery_1",
      purpose: "customer_login",
      otpExpiresAt: 4_102_444_800,
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
        idempotencyKey: "otp_delivery_1",
      }),
      {
        db: { id: "db" },
        env,
        encryptionKey: "credential-key",
      },
    );
    expect(mocks.markAuthOtpDeliveryReceiptAccepted).toHaveBeenCalledWith(
      { id: "db" },
      {
        id: "aor_1",
        deliveryKey: "otp_delivery_1",
        claimId: "aorc_1",
        attempts: 1,
      },
      {
        provider: "cloudflare",
        providerMessageId: "cf_msg_1",
        providerStatus: "accepted",
      },
    );
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it("retries OTP email when providers fall back to local logging", async () => {
    mocks.sendEmail.mockResolvedValue({
      success: false,
      provider: "log",
      rawStatus: "No configured email provider available; email not delivered",
    });
    const message = createMessage({
      type: "auth.send_otp",
      deliveryKey: "otp_delivery_1",
      otpExpiresAt: 4_102_444_800,
      method: "email",
      allowedMethod: "email",
      identifier: "buyer@example.com",
      code: "123456",
      name: "Buyer",
    } as const);

    await handleQueueBatch(createBatch([message]), {} as Env);

    expect(mocks.markAuthOtpDeliveryReceiptFailed).toHaveBeenCalledWith(
      { id: "db" },
      expect.objectContaining({ id: "aor_1", claimId: "aorc_1" }),
      expect.any(Error),
      {
        provider: "log",
        providerMessageId: undefined,
        providerStatus: "No configured email provider available; email not delivered",
      },
    );
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
  });

  it("passes deterministic OTP client references to the active SMS provider", async () => {
    const smsProvider = {
      name: "gennet",
      validateConfig: vi.fn(() => null),
      sendSms: vi.fn().mockResolvedValue({
        success: true,
        providerRef: "sms_ref_1",
        rawStatus: "SUCCESS",
      }),
    };
    mocks.getActiveSmsProvider.mockResolvedValue(smsProvider);
    const message = createMessage({
      type: "auth.send_otp",
      deliveryKey: "otp_delivery_sms_1",
      otpExpiresAt: 4_102_444_800,
      method: "phone",
      allowedMethod: "sms_otp",
      identifier: "+8801712345678",
      code: "654321",
      name: "Buyer",
    } as const);

    await handleQueueBatch(createBatch([message]), {} as Env);

    expect(smsProvider.sendSms).toHaveBeenCalledWith({
      to: "+8801712345678",
      message: "Your login code: 654321\n\nValid for 5 minutes. Do not share.",
      clientReference: "otpclientref1",
    });
    expect(mocks.markAuthOtpDeliveryReceiptAccepted).toHaveBeenCalledWith(
      { id: "db" },
      expect.objectContaining({ id: "aor_1", claimId: "aorc_1" }),
      {
        provider: "gennet",
        providerMessageId: "sms_ref_1",
        providerStatus: "SUCCESS",
      },
    );
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it("records WhatsApp OTP message IDs after resolving encrypted Meta credentials", async () => {
    const message = createMessage({
      type: "auth.send_otp",
      deliveryKey: "otp_delivery_wa_1",
      otpExpiresAt: 4_102_444_800,
      method: "phone",
      allowedMethod: "whatsapp_otp",
      identifier: "+8801712345678",
      code: "654321",
      name: "Buyer",
    } as const);

    await handleQueueBatch(createBatch([message]), {} as Env);

    expect(mocks.getWhatsAppCloudApiSettings).toHaveBeenCalledWith(
      { id: "db" },
      "credential-key",
      {
        migrateLegacy: true,
        migrationEncryptionKey: "credential-key",
      },
    );
    expect(mocks.sendWhatsAppTemplateMessage).toHaveBeenCalledWith({
      accessToken: "wa_token",
      phoneNumberId: "phone_id_1",
      to: "+8801712345678",
      templateName: "auth_otp",
      languageCode: "en_US",
      bodyParameters: ["654321"],
      buttonUrlParameter: "654321",
    });
    expect(mocks.markAuthOtpDeliveryReceiptAccepted).toHaveBeenCalledWith(
      { id: "db" },
      expect.objectContaining({ id: "aor_1", claimId: "aorc_1" }),
      {
        provider: "whatsapp",
        providerMessageId: "wamid.otp.1",
        providerStatus: "accepted",
        rawResponse: JSON.stringify({ messageId: "wamid.otp.1", messageStatus: "accepted" }),
      },
    );
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it("skips expired OTP deliveries instead of sending stale codes", async () => {
    const message = createMessage({
      type: "auth.send_otp",
      deliveryKey: "otp_delivery_expired_1",
      otpExpiresAt: 1,
      method: "email",
      allowedMethod: "email",
      identifier: "buyer@example.com",
      code: "123456",
      name: "Buyer",
    } as const);

    await handleQueueBatch(createBatch([message]), {} as Env);

    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.markAuthOtpDeliveryReceiptSkipped).toHaveBeenCalledWith(
      { id: "db" },
      expect.objectContaining({ id: "aor_1", claimId: "aorc_1" }),
      "otp_expired",
      {
        provider: "email",
        providerStatus: "otp_expired",
      },
    );
    expect(message.ack).toHaveBeenCalledTimes(1);
  });
});
