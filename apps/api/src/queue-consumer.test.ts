import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(() => ({ id: "db" })),
  processPaymentConfirmed: vi.fn(),
  processPaymentFailed: vi.fn(),
  processExistingMetaPurchaseOutboxForOrder: vi.fn(),
  releaseOrderInventory: vi.fn(),
  processPolarWebhookRefund: vi.fn(),
  sendOrderNotificationEmail: vi.fn(),
  sendOrderNotification: vi.fn(),
  sendEmail: vi.fn(),
  getWhatsAppCloudApiSettings: vi.fn(),
  sendWhatsAppTemplateMessage: vi.fn(),
  getDecimalPlaces: vi.fn(() => 2),
  getActiveSmsProvider: vi.fn(),
  getNotificationProviderBlock: vi.fn(),
  isNotificationProviderBreakerFailure: vi.fn(),
  markNotificationProviderBlocked: vi.fn(),
  getEncryptionKey: vi.fn(() => "test-key"),
  getCredentialEncryptionKey: vi.fn(() => "credential-key"),
  invalidateProductAvailabilityCaches: vi.fn(),
  purgeStorefrontForPrefixes: vi.fn(),
  createStorefrontCacheWarmMessageForPurge: vi.fn(),
  enqueueStorefrontCacheWarm: vi.fn(),
  warmStorefrontHtmlPaths: vi.fn(),
  enqueueOrderBalancePaidNotificationForOrder: vi.fn(),
  enqueueOrderCreatedNotificationForOrder: vi.fn(),
  enqueueOrderRefundNotificationForOrder: vi.fn(),
  getAdminNotificationChannels: vi.fn(),
  claimOrderNotificationOutboxForProcessing: vi.fn(),
  markOrderNotificationOutboxDeadLettered: vi.fn(),
  markOrderNotificationOutboxProcessingFailed: vi.fn(),
  markOrderNotificationOutboxSent: vi.fn(),
  createAuthOtpDeliveryTarget: vi.fn(),
  claimAuthOtpDeliveryReceipt: vi.fn(),
  getAuthOtpDeliveryRetryDelaySeconds: vi.fn((attempts: number) => Math.min(3600, 30 * 2 ** (Math.max(1, attempts) - 1))),
  markAuthOtpDeliveryReceiptAccepted: vi.fn(),
  markAuthOtpDeliveryReceiptAcceptedByDeliveryKey: vi.fn(),
  markAuthOtpDeliveryReceiptFailed: vi.fn(),
  markAuthOtpDeliveryReceiptSkipped: vi.fn(),
  markAuthOtpDeliveryReceiptSkippedByDeliveryKey: vi.fn(),
  createAuthOtpProviderClientReference: vi.fn(() => "otpclientref1"),
  markWebhookEventProcessed: vi.fn(),
  markWebhookEventFailed: vi.fn(),
  markWebhookEventManualReconciliation: vi.fn(),
  recordPaymentWebhookDlqEvidence: vi.fn(),
  archiveStorefrontCacheQueueFailure: vi.fn(),
}));

vi.mock("@scalius/database/client", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@scalius/core/modules/payments/process-payment", () => ({
  processPaymentConfirmed: mocks.processPaymentConfirmed,
  processPaymentFailed: mocks.processPaymentFailed,
  releaseOrderInventory: mocks.releaseOrderInventory,
}));

vi.mock("@scalius/core/integrations/meta/purchase-outbox", () => ({
  processExistingMetaPurchaseOutboxForOrder: mocks.processExistingMetaPurchaseOutboxForOrder,
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
  markOrderNotificationOutboxDeadLettered: mocks.markOrderNotificationOutboxDeadLettered,
  markOrderNotificationOutboxProcessingFailed: mocks.markOrderNotificationOutboxProcessingFailed,
  markOrderNotificationOutboxSent: mocks.markOrderNotificationOutboxSent,
}));

vi.mock("@scalius/core/modules/customers/otp-delivery-receipts", () => ({
  createAuthOtpDeliveryTarget: mocks.createAuthOtpDeliveryTarget,
  claimAuthOtpDeliveryReceipt: mocks.claimAuthOtpDeliveryReceipt,
  getAuthOtpDeliveryRetryDelaySeconds: mocks.getAuthOtpDeliveryRetryDelaySeconds,
  markAuthOtpDeliveryReceiptAccepted: mocks.markAuthOtpDeliveryReceiptAccepted,
  markAuthOtpDeliveryReceiptAcceptedByDeliveryKey: mocks.markAuthOtpDeliveryReceiptAcceptedByDeliveryKey,
  markAuthOtpDeliveryReceiptFailed: mocks.markAuthOtpDeliveryReceiptFailed,
  markAuthOtpDeliveryReceiptSkipped: mocks.markAuthOtpDeliveryReceiptSkipped,
  markAuthOtpDeliveryReceiptSkippedByDeliveryKey: mocks.markAuthOtpDeliveryReceiptSkippedByDeliveryKey,
  createAuthOtpProviderClientReference: mocks.createAuthOtpProviderClientReference,
}));

vi.mock("@scalius/core/integrations/email", () => ({
  sendEmail: mocks.sendEmail,
}));

vi.mock("@scalius/core/integrations/whatsapp", () => ({
  getWhatsAppCloudApiSettings: mocks.getWhatsAppCloudApiSettings,
  sendWhatsAppTemplateMessage: mocks.sendWhatsAppTemplateMessage,
}));

vi.mock("@scalius/shared/currency", () => ({
  getDecimalPlaces: mocks.getDecimalPlaces,
}));

vi.mock("@scalius/core/integrations/sms", () => ({
  getActiveSmsProvider: mocks.getActiveSmsProvider,
}));

vi.mock("@scalius/core/modules/notifications/notification-provider-health", () => ({
  getNotificationProviderBlock: mocks.getNotificationProviderBlock,
  isNotificationProviderBreakerFailure: mocks.isNotificationProviderBreakerFailure,
  markNotificationProviderBlocked: mocks.markNotificationProviderBlocked,
}));

vi.mock("./utils/encryption-key", () => ({
  getEncryptionKey: mocks.getEncryptionKey,
  getCredentialEncryptionKey: mocks.getCredentialEncryptionKey,
}));

vi.mock("./utils/cache-invalidation", () => ({
  invalidateProductAvailabilityCaches: mocks.invalidateProductAvailabilityCaches,
  purgeStorefrontForPrefixes: mocks.purgeStorefrontForPrefixes,
  createStorefrontCacheWarmMessageForPurge: mocks.createStorefrontCacheWarmMessageForPurge,
  enqueueStorefrontCacheWarm: mocks.enqueueStorefrontCacheWarm,
  warmStorefrontHtmlPaths: mocks.warmStorefrontHtmlPaths,
}));

vi.mock("./utils/order-notification-queue", () => ({
  enqueueOrderBalancePaidNotificationForOrder: mocks.enqueueOrderBalancePaidNotificationForOrder,
  enqueueOrderCreatedNotificationForOrder: mocks.enqueueOrderCreatedNotificationForOrder,
  enqueueOrderRefundNotificationForOrder: mocks.enqueueOrderRefundNotificationForOrder,
}));

vi.mock("@scalius/core/modules/settings/settings.service", () => ({
  getAdminNotificationChannels: mocks.getAdminNotificationChannels,
}));

vi.mock("./utils/webhook-idempotency", () => ({
  buildWebhookEventId: (provider: string, eventType: string, sourceEventId: string) =>
    `${provider}:${eventType}:${sourceEventId}`
      .toLowerCase()
      .replace(/[^a-z0-9:_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, ""),
  markWebhookEventProcessed: mocks.markWebhookEventProcessed,
  markWebhookEventFailed: mocks.markWebhookEventFailed,
  markWebhookEventManualReconciliation: mocks.markWebhookEventManualReconciliation,
  recordPaymentWebhookDlqEvidence: mocks.recordPaymentWebhookDlqEvidence,
}));

vi.mock("./utils/storefront-cache-queue-failures", () => ({
  archiveStorefrontCacheQueueFailure: mocks.archiveStorefrontCacheQueueFailure,
}));

import {
  handleQueueBatch,
  type PaymentQueueMessage,
  type StorefrontCacheQueueMessage,
} from "./queue-consumer";

function createMessage(body: PaymentQueueMessage, attempts?: number): Message<PaymentQueueMessage>;
function createMessage<T>(body: T, attempts?: number): Message<T>;
function createMessage<T>(body: T, attempts = 1): Message<T> {
  const record = body as Record<string, unknown>;
  return {
    id: `msg-${String(record.type)}-${String(record.orderId ?? "no-order")}`,
    timestamp: new Date("2026-01-01T00:00:00Z"),
    body,
    attempts,
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

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("handleQueueBatch payment confirmation retries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.sendOrderNotificationEmail.mockResolvedValue(undefined);
    mocks.sendOrderNotification.mockResolvedValue(undefined);
    mocks.purgeStorefrontForPrefixes.mockResolvedValue({
      attempted: true,
      ok: true,
      status: 200,
    });
    mocks.createStorefrontCacheWarmMessageForPurge.mockReturnValue(null);
    mocks.enqueueStorefrontCacheWarm.mockResolvedValue({ enqueued: true });
    mocks.warmStorefrontHtmlPaths.mockResolvedValue({
      attempted: true,
      ok: true,
      paths: ["/"],
      successful: 1,
      skipped: 0,
      retryableFailures: [],
      skippedFailures: [],
    });
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
    mocks.getNotificationProviderBlock.mockResolvedValue(null);
    mocks.isNotificationProviderBreakerFailure.mockImplementation((value: string | null | undefined) => {
      const status = value?.trim() ?? "";
      return /auth(?:orization|entication)?\s+(?:required|failed|error)/i.test(status)
        || /unauthori[sz]ed/i.test(status)
        || /forbidden/i.test(status)
        || /invalid\s+(?:api\s*)?(?:key|token|credential)/i.test(status)
        || /could not be decrypted/i.test(status)
        || /\b(?:http|status|code|error)[^0-9]*(?:401|402|403|405)\b/i.test(status);
    });
    mocks.markNotificationProviderBlocked.mockResolvedValue(undefined);
    mocks.getAdminNotificationChannels.mockResolvedValue({});
    mocks.enqueueOrderCreatedNotificationForOrder.mockResolvedValue({
      orderId: "order_1",
      outboxId: "outbox_order_1",
      enqueued: true,
    });
    mocks.enqueueOrderBalancePaidNotificationForOrder.mockResolvedValue({
      orderId: "order_1",
      outboxId: "outbox_balance_1",
      enqueued: true,
    });
    mocks.enqueueOrderRefundNotificationForOrder.mockResolvedValue({
      orderId: "order_1",
      outboxId: "outbox_refund_1",
      enqueued: true,
    });
    mocks.claimOrderNotificationOutboxForProcessing.mockResolvedValue({
      claimed: true,
      outboxId: "outbox_1",
      claimId: "claim_1",
      attempts: 2,
    });
    mocks.markOrderNotificationOutboxProcessingFailed.mockResolvedValue(undefined);
    mocks.markOrderNotificationOutboxDeadLettered.mockResolvedValue({ marked: true });
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
    mocks.markAuthOtpDeliveryReceiptAcceptedByDeliveryKey.mockResolvedValue("accepted");
    mocks.markAuthOtpDeliveryReceiptFailed.mockResolvedValue(undefined);
    mocks.markAuthOtpDeliveryReceiptSkipped.mockResolvedValue(undefined);
    mocks.markAuthOtpDeliveryReceiptSkippedByDeliveryKey.mockResolvedValue("skipped");
    mocks.getAuthOtpDeliveryRetryDelaySeconds.mockImplementation((attempts: number) =>
      Math.min(3600, 30 * 2 ** (Math.max(1, attempts) - 1)),
    );
    mocks.createAuthOtpProviderClientReference.mockReturnValue("otpclientref1");
    mocks.markWebhookEventProcessed.mockResolvedValue(undefined);
    mocks.markWebhookEventFailed.mockResolvedValue(undefined);
    mocks.markWebhookEventManualReconciliation.mockResolvedValue(undefined);
    mocks.recordPaymentWebhookDlqEvidence.mockResolvedValue({
      id: "stripe:payment_intent.succeeded:evt_dlq",
      status: "failed",
      inserted: false,
    });
    mocks.archiveStorefrontCacheQueueFailure.mockResolvedValue({
      id: "scqf_1",
    });
    mocks.processExistingMetaPurchaseOutboxForOrder.mockResolvedValue({
      outboxId: "mcp_order_1",
      missing: false,
      processed: true,
      status: "sent",
    });
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
    expect(mocks.markWebhookEventFailed).not.toHaveBeenCalled();
  });

  it("caps normal queue message concurrency while preserving individual ack and retry", async () => {
    const firstWave = createDeferred();
    const finalMessage = createDeferred();
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;

    mocks.processPaymentConfirmed.mockImplementation(async (_db, input: { orderId: string }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      started.push(input.orderId);
      try {
        if (input.orderId === "order-4") {
          await finalMessage.promise;
          return { success: false, error: "D1 overloaded" };
        }

        await firstWave.promise;
        return { success: true };
      } finally {
        active -= 1;
      }
    });

    const messages = ["order-1", "order-2", "order-3", "order-4"].map((orderId) =>
      createMessage({
        type: "payment.stripe.confirmed",
        orderId,
        paymentIntentId: `pi_${orderId}`,
        amount: 1000,
        currency: "bdt",
      }),
    );

    const run = handleQueueBatch(createBatch(messages), {} as Env);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(started).toEqual(["order-1", "order-2", "order-3"]);
    expect(maxActive).toBe(3);

    firstWave.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(started).toEqual(["order-1", "order-2", "order-3", "order-4"]);
    expect(maxActive).toBe(3);

    finalMessage.resolve();
    await run;

    for (const message of messages.slice(0, 3)) {
      expect(message.ack).toHaveBeenCalledTimes(1);
      expect(message.retry).not.toHaveBeenCalled();
    }
    expect(messages[3]?.ack).not.toHaveBeenCalled();
    expect(messages[3]?.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("event=queue_batch_completed"),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("queue=payment-events-queue, messages=4, acked=3, retried=1"),
    );
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
    expect(mocks.processExistingMetaPurchaseOutboxForOrder).toHaveBeenCalledWith({
      db: { id: "db" },
      orderId: "order-stripe",
      source: "payment-stripe-confirmed",
      storefrontUrl: undefined,
      encryptionKey: "credential-key",
    });
    expect(mocks.markWebhookEventProcessed).not.toHaveBeenCalled();
  });

  it("enqueues balance-paid notifications instead of order-created notifications for balance payments", async () => {
    mocks.processPaymentConfirmed.mockResolvedValue({ success: true });
    const notificationQueue = { send: vi.fn(async () => undefined) };

    const message = createMessage({
      type: "payment.sslcommerz.confirmed",
      orderId: "order-balance",
      tranId: "tran_balance",
      valId: "val_balance",
      bankTranId: "bank_balance",
      amount: 750,
      currency: "BDT",
      paymentType: "balance",
    });

    await handleQueueBatch(createBatch([message]), {
      ORDER_NOTIFICATIONS_QUEUE: notificationQueue,
    } as unknown as Env);

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(mocks.processPaymentConfirmed).toHaveBeenCalledWith(
      { id: "db" },
      expect.objectContaining({
        orderId: "order-balance",
        paymentGateway: "sslcommerz",
        paymentType: "balance",
        amount: 750,
      }),
    );
    expect(mocks.enqueueOrderCreatedNotificationForOrder).not.toHaveBeenCalled();
    expect(mocks.enqueueOrderBalancePaidNotificationForOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        db: { id: "db" },
        queue: notificationQueue,
        orderId: "order-balance",
        source: "payment-sslcommerz-balance-paid",
        amount: 750,
        gateway: "sslcommerz",
        retryOnQueueFailure: true,
      }),
    );
  });

  it("enqueues Stripe balance-paid notifications using major currency amount", async () => {
    mocks.processPaymentConfirmed.mockResolvedValue({ success: true });
    const notificationQueue = { send: vi.fn(async () => undefined) };

    const message = createMessage({
      type: "payment.stripe.confirmed",
      orderId: "order-stripe-balance",
      paymentIntentId: "pi_balance",
      amount: 6500,
      currency: "bdt",
      metadata: { paymentType: "balance" },
    });

    await handleQueueBatch(createBatch([message]), {
      ORDER_NOTIFICATIONS_QUEUE: notificationQueue,
    } as unknown as Env);

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(mocks.processPaymentConfirmed).toHaveBeenCalledWith(
      { id: "db" },
      expect.objectContaining({
        orderId: "order-stripe-balance",
        paymentGateway: "stripe",
        paymentType: "balance",
        amount: 65,
      }),
    );
    expect(mocks.enqueueOrderCreatedNotificationForOrder).not.toHaveBeenCalled();
    expect(mocks.enqueueOrderBalancePaidNotificationForOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        queue: notificationQueue,
        orderId: "order-stripe-balance",
        source: "payment-stripe-balance-paid",
        amount: 65,
        gateway: "stripe",
        retryOnQueueFailure: true,
      }),
    );
  });

  it("enqueues Polar balance-paid notifications using the original local amount", async () => {
    mocks.processPaymentConfirmed.mockResolvedValue({ success: true });
    const notificationQueue = { send: vi.fn(async () => undefined) };

    const message = createMessage({
      type: "payment.polar.confirmed",
      orderId: "order-polar-balance",
      checkoutId: "polar_checkout_1",
      amount: 840,
      currency: "usd",
      paymentType: "balance",
      metadata: { originalAmount: "1000", exchangeRate: "0.0084" },
    });

    await handleQueueBatch(createBatch([message]), {
      ORDER_NOTIFICATIONS_QUEUE: notificationQueue,
    } as unknown as Env);

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(mocks.processPaymentConfirmed).toHaveBeenCalledWith(
      { id: "db" },
      expect.objectContaining({
        orderId: "order-polar-balance",
        paymentGateway: "polar",
        paymentType: "balance",
        amount: 1000,
      }),
    );
    expect(mocks.enqueueOrderCreatedNotificationForOrder).not.toHaveBeenCalled();
    expect(mocks.enqueueOrderBalancePaidNotificationForOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        queue: notificationQueue,
        orderId: "order-polar-balance",
        source: "payment-polar-balance-paid",
        amount: 1000,
        gateway: "polar",
        retryOnQueueFailure: true,
      }),
    );
  });

  it("enqueues Polar refund notifications only after the webhook refund processor succeeds", async () => {
    mocks.processPolarWebhookRefund.mockResolvedValue({
      success: true,
      notification: {
        notificationType: "order_refunded",
        dedupeKey: "polar-refund:order-polar:full",
        data: {
          gateway: "polar",
          polarStatus: "refunded",
          amountRefunded: 10_000,
          totalAmount: 10_000,
          currency: "usd",
          localRefundAmount: 100,
        },
      },
    });
    const notificationQueue = { send: vi.fn(async () => undefined) };

    const message = createMessage({
      type: "payment.polar.refunded",
      webhookEventId: "polar:order.refunded:evt_refund",
      orderId: "order-polar",
      polarCheckoutId: "checkout_polar",
      amountRefunded: 10_000,
      totalAmount: 10_000,
      currency: "usd",
      polarStatus: "refunded",
    });

    await handleQueueBatch(createBatch([message]), {
      ORDER_NOTIFICATIONS_QUEUE: notificationQueue,
    } as unknown as Env);

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(mocks.processPolarWebhookRefund).toHaveBeenCalledWith(
      { id: "db" },
      {
        orderId: "order-polar",
        polarCheckoutId: "checkout_polar",
        amountRefunded: 10_000,
        totalAmount: 10_000,
        currency: "usd",
        polarStatus: "refunded",
      },
    );
    expect(mocks.invalidateProductAvailabilityCaches).toHaveBeenCalledWith(
      { id: "db" },
      { orderIds: ["order-polar"] },
      { env: { ORDER_NOTIFICATIONS_QUEUE: notificationQueue }, executionCtx: undefined },
    );
    expect(mocks.enqueueOrderRefundNotificationForOrder).toHaveBeenCalledWith({
      db: { id: "db" },
      queue: notificationQueue,
      orderId: "order-polar",
      notificationType: "order_refunded",
      dedupeKey: "polar-refund:order-polar:full",
      source: "payment-polar-refunded",
      data: {
        gateway: "polar",
        polarStatus: "refunded",
        amountRefunded: 10_000,
        totalAmount: 10_000,
        currency: "usd",
        localRefundAmount: 100,
      },
    });
    expect(mocks.markWebhookEventProcessed).toHaveBeenCalledWith(
      { id: "db" },
      "polar:order.refunded:evt_refund",
      expect.objectContaining({
        queueType: "payment.polar.refunded",
        orderId: "order-polar",
        gateway: "polar",
        outcome: "refunded",
      }),
    );
  });

  it("does not enqueue Polar refund notifications when local refund processing fails", async () => {
    mocks.processPolarWebhookRefund.mockResolvedValue({
      success: false,
      error: "Order was modified concurrently while applying Polar refund; retry required",
    });

    const message = createMessage({
      type: "payment.polar.refunded",
      webhookEventId: "polar:order.refunded:evt_retry",
      orderId: "order-polar",
      polarCheckoutId: "checkout_polar",
      amountRefunded: 10_000,
      totalAmount: 10_000,
      currency: "usd",
      polarStatus: "refunded",
    });

    await handleQueueBatch(createBatch([message]), {} as Env);

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(mocks.invalidateProductAvailabilityCaches).not.toHaveBeenCalled();
    expect(mocks.enqueueOrderRefundNotificationForOrder).not.toHaveBeenCalled();
    expect(mocks.markWebhookEventProcessed).not.toHaveBeenCalled();
  });

  it("keeps Stripe refund webhooks audit-only until scheduled reconciliation imports them", async () => {
    const message = createMessage({
      type: "payment.stripe.refunded",
      webhookEventId: "stripe:charge-refunded:evt_refund",
      orderId: "order-stripe",
      paymentIntentId: "pi_stripe",
      amountRefunded: 1500,
      currency: "bdt",
      chargeId: "ch_stripe",
      refunds: [{
        id: "re_stripe",
        amount: 1500,
        currency: "bdt",
        status: "succeeded",
      }],
    });

    await handleQueueBatch(createBatch([message]), {} as Env);

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateProductAvailabilityCaches).not.toHaveBeenCalled();
    expect(mocks.enqueueOrderRefundNotificationForOrder).not.toHaveBeenCalled();
    expect(mocks.markWebhookEventProcessed).not.toHaveBeenCalled();
    expect(mocks.markWebhookEventManualReconciliation).toHaveBeenCalledWith(
      { id: "db" },
      "stripe:charge-refunded:evt_refund",
      expect.objectContaining({
        queueType: "payment.stripe.refunded",
        orderId: "order-stripe",
        gateway: "stripe",
        outcome: "external_refund_observed",
        amountRefunded: 1500,
        currency: "bdt",
        paymentIntentId: "pi_stripe",
        chargeId: "ch_stripe",
        refunds: [{
          id: "re_stripe",
          amount: 1500,
          currency: "bdt",
          status: "succeeded",
        }],
      }),
    );
  });

  it("marks webhook events processed after confirmed payment side effects succeed", async () => {
    mocks.processPaymentConfirmed.mockResolvedValue({ success: true });
    const notificationQueue = { send: vi.fn(async () => undefined) };

    const message = createMessage({
      type: "payment.stripe.confirmed",
      webhookEventId: "stripe:payment_intent.succeeded:evt_1",
      orderId: "order-stripe",
      paymentIntentId: "pi_123",
      amount: 12345,
      currency: "usd",
    });

    await handleQueueBatch(createBatch([message]), {
      ORDER_NOTIFICATIONS_QUEUE: notificationQueue,
    } as unknown as Env);

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(mocks.markWebhookEventProcessed).toHaveBeenCalledWith(
      { id: "db" },
      "stripe:payment_intent.succeeded:evt_1",
      expect.objectContaining({
        queueMessageId: message.id,
        queueType: "payment.stripe.confirmed",
        orderId: "order-stripe",
        gateway: "stripe",
        outcome: "confirmed",
      }),
    );
    expect(mocks.markWebhookEventManualReconciliation).not.toHaveBeenCalled();
  });

  it("acks non-retryable confirmed payment guard failures", async () => {
    mocks.processPaymentConfirmed.mockResolvedValue({
      success: false,
      error: "Cannot pay a cancelled order",
      retryable: false,
    });

    const message = createMessage({
      type: "payment.stripe.confirmed",
      webhookEventId: "stripe:payment_intent.succeeded:evt_late",
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
    expect(mocks.markWebhookEventManualReconciliation).toHaveBeenCalledWith(
      { id: "db" },
      "stripe:payment_intent.succeeded:evt_late",
      expect.objectContaining({
        queueMessageId: message.id,
        queueType: "payment.stripe.confirmed",
        orderId: "order-stripe",
        gateway: "stripe",
        outcome: "manual_reconciliation",
        error: "Cannot pay a cancelled order",
      }),
    );
  });

  it("keeps retryable webhook failures queued before the terminal delivery attempt", async () => {
    mocks.processPaymentConfirmed.mockResolvedValue({ success: false, error: "D1 batch failed" });

    const message = createMessage({
      type: "payment.stripe.confirmed",
      webhookEventId: "stripe:payment_intent.succeeded:evt_retry",
      orderId: "order-stripe",
      paymentIntentId: "pi_retry",
      amount: 12345,
      currency: "usd",
    });

    await handleQueueBatch(createBatch([message]), {} as Env);

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(mocks.markWebhookEventFailed).not.toHaveBeenCalled();
    expect(mocks.markWebhookEventProcessed).not.toHaveBeenCalled();
    expect(mocks.markWebhookEventManualReconciliation).not.toHaveBeenCalled();
  });

  it("marks retryable webhook failures failed on the terminal delivery attempt", async () => {
    mocks.processPaymentConfirmed.mockResolvedValue({ success: false, error: "D1 batch failed" });

    const message = createMessage({
      type: "payment.stripe.confirmed",
      webhookEventId: "stripe:payment_intent.succeeded:evt_terminal",
      orderId: "order-stripe",
      paymentIntentId: "pi_terminal",
      amount: 12345,
      currency: "usd",
    }, 4);

    await handleQueueBatch(createBatch([message]), {} as Env);

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(mocks.markWebhookEventFailed).toHaveBeenCalledWith(
      { id: "db" },
      "stripe:payment_intent.succeeded:evt_terminal",
      expect.objectContaining({
        queueMessageId: message.id,
        queueType: "payment.stripe.confirmed",
        orderId: "order-stripe",
        terminalDeliveryAttempt: 4,
        maxRetries: 3,
        error: "stripe payment confirmation failed for order order-stripe: D1 batch failed",
      }),
    );
    expect(mocks.markWebhookEventProcessed).not.toHaveBeenCalled();
  });

  it("archives payment DLQ messages without reprocessing payment side effects", async () => {
    const message = createMessage({
      type: "payment.stripe.confirmed",
      webhookEventId: "stripe:payment_intent.succeeded:evt_dlq",
      orderId: "order-stripe",
      paymentIntentId: "pi_dlq",
      amount: 12345,
      currency: "usd",
      metadata: { paymentType: "deposit", ignored: "not persisted" },
    }, 5);

    await handleQueueBatch(createBatch([message], "payment-events-dlq") as never, {} as Env);

    expect(mocks.processPaymentConfirmed).not.toHaveBeenCalled();
    expect(mocks.markWebhookEventProcessed).not.toHaveBeenCalled();
    expect(mocks.markWebhookEventFailed).not.toHaveBeenCalled();
    expect(mocks.recordPaymentWebhookDlqEvidence).toHaveBeenCalledWith(
      { id: "db" },
      expect.objectContaining({
        webhookEventId: "stripe:payment_intent.succeeded:evt_dlq",
        provider: "stripe",
        eventType: "payment.stripe.confirmed",
        orderId: "order-stripe",
        queueMessageId: message.id,
        queueType: "payment.stripe.confirmed",
        attempts: 5,
        messageTimestampSeconds: 1_767_225_600,
        payment: {
          paymentIntentId: "pi_dlq",
          amount: 12345,
          currency: "usd",
          chargeId: null,
          paymentType: "deposit",
        },
      }),
    );
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("retries payment DLQ messages when evidence persistence fails", async () => {
    mocks.recordPaymentWebhookDlqEvidence.mockRejectedValueOnce(new Error("D1 unavailable"));
    const message = createMessage({
      type: "payment.sslcommerz.confirmed",
      webhookEventId: "sslcommerz:ipn:tran:val",
      orderId: "order-ssl",
      tranId: "tran_123",
      valId: "val_123",
      bankTranId: "bank_123",
      amount: 1200,
      currency: "BDT",
      paymentType: "full",
    }, 5);

    await handleQueueBatch(createBatch([message], "payment-events-dlq") as never, {} as Env);

    expect(mocks.processPaymentConfirmed).not.toHaveBeenCalled();
    expect(mocks.recordPaymentWebhookDlqEvidence).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 300 });
  });

  it("caps payment DLQ archive concurrency while preserving per-message ack and retry", async () => {
    const firstWave = createDeferred();
    const finalMessage = createDeferred();
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;

    mocks.recordPaymentWebhookDlqEvidence.mockImplementation(async (_db, evidence: { orderId?: string }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      started.push(evidence.orderId ?? "unknown");
      try {
        if (evidence.orderId === "order-dlq-3") {
          await finalMessage.promise;
          throw new Error("D1 unavailable");
        }

        await firstWave.promise;
        return {
          id: `stripe:payment_intent.succeeded:${evidence.orderId}`,
          status: "failed",
          inserted: false,
        };
      } finally {
        active -= 1;
      }
    });

    const messages = ["order-dlq-1", "order-dlq-2", "order-dlq-3"].map((orderId) =>
      createMessage({
        type: "payment.stripe.confirmed",
        webhookEventId: `stripe:payment_intent.succeeded:${orderId}`,
        orderId,
        paymentIntentId: `pi_${orderId}`,
        amount: 1000,
        currency: "bdt",
      }, 5),
    );

    const run = handleQueueBatch(createBatch(messages, "payment-events-dlq") as never, {} as Env);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(started).toEqual(["order-dlq-1", "order-dlq-2"]);
    expect(maxActive).toBe(2);

    firstWave.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(started).toEqual(["order-dlq-1", "order-dlq-2", "order-dlq-3"]);
    expect(maxActive).toBe(2);

    finalMessage.resolve();
    await run;

    for (const message of messages.slice(0, 2)) {
      expect(message.ack).toHaveBeenCalledTimes(1);
      expect(message.retry).not.toHaveBeenCalled();
    }
    expect(messages[2]?.ack).not.toHaveBeenCalled();
    expect(messages[2]?.retry).toHaveBeenCalledWith({ delaySeconds: 300 });
    expect(mocks.processPaymentConfirmed).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("event=queue_batch_completed"),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("queue=payment-events-dlq, messages=3, acked=2, retried=1"),
    );
  });

  it("archives storefront cache DLQ messages without replaying cache side effects", async () => {
    const message = createMessage<StorefrontCacheQueueMessage>({
      type: "storefront.cache_purge",
      operationId: "purge_dlq_1",
      groups: ["products"],
      prefixes: ["product_slug_fish"],
      exactKeys: ["product_variants_prod_1"],
      htmlPaths: ["/products/fish"],
      bumpVersion: false,
      source: "catalog:products",
      requestedAt: 1_790_000_000_000,
    }, 6);

    await handleQueueBatch(createBatch([message], "storefront-cache-dlq"), {} as Env);

    expect(mocks.archiveStorefrontCacheQueueFailure).toHaveBeenCalledWith(
      { id: "db" },
      message,
      "storefront-cache-dlq",
    );
    expect(mocks.purgeStorefrontForPrefixes).not.toHaveBeenCalled();
    expect(mocks.warmStorefrontHtmlPaths).not.toHaveBeenCalled();
    expect(mocks.enqueueStorefrontCacheWarm).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("retries storefront cache DLQ messages when evidence persistence fails", async () => {
    mocks.archiveStorefrontCacheQueueFailure.mockRejectedValueOnce(new Error("D1 unavailable"));
    const message = createMessage<StorefrontCacheQueueMessage>({
      type: "storefront.cache_warm",
      operationId: "warm_dlq_1",
      paths: ["/products/fish"],
      source: "catalog:products:warm",
      requestedAt: 1_790_000_000_000,
    }, 6);

    await handleQueueBatch(createBatch([message], "storefront-cache-dlq"), {} as Env);

    expect(mocks.archiveStorefrontCacheQueueFailure).toHaveBeenCalledTimes(1);
    expect(mocks.warmStorefrontHtmlPaths).not.toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 300 });
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

  it("retries confirmed balance payment messages when balance-paid notification enqueue fails", async () => {
    mocks.processPaymentConfirmed.mockResolvedValue({ success: true });
    mocks.enqueueOrderBalancePaidNotificationForOrder.mockRejectedValue(new Error("queue unavailable"));

    const message = createMessage({
      type: "payment.stripe.confirmed",
      orderId: "order-balance",
      paymentIntentId: "pi_balance",
      amount: 6500,
      currency: "bdt",
      metadata: { paymentType: "balance" },
    });

    await handleQueueBatch(createBatch([message]), {} as Env);

    expect(mocks.processPaymentConfirmed).toHaveBeenCalledWith(
      { id: "db" },
      expect.objectContaining({
        orderId: "order-balance",
        paymentGateway: "stripe",
        paymentType: "balance",
        amount: 65,
      }),
    );
    expect(mocks.enqueueOrderCreatedNotificationForOrder).not.toHaveBeenCalled();
    expect(mocks.enqueueOrderBalancePaidNotificationForOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "order-balance",
        source: "payment-stripe-balance-paid",
        amount: 65,
        gateway: "stripe",
        retryOnQueueFailure: true,
      }),
    );
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
  });

  it("ignores stale order-ingest-shaped messages on non-order queues", async () => {
    mocks.processPaymentConfirmed.mockResolvedValue({ success: true });
    const payment = createMessage({
      type: "payment.stripe.confirmed",
      orderId: "order-stripe",
      paymentIntentId: "pi_123",
      amount: 12345,
      currency: "usd",
    });
    const staleOrderIngest = createMessage({
      type: "order.ingest",
      orderData: { id: "order_stray" },
      items: [],
    } as unknown as PaymentQueueMessage);

    await handleQueueBatch(
      createBatch([payment, staleOrderIngest] as Array<Message<Record<string, unknown>>>) as never,
      {} as Env,
    );

    expect(mocks.processPaymentConfirmed).toHaveBeenCalledTimes(1);
    expect(payment.ack).toHaveBeenCalledTimes(1);
    expect(staleOrderIngest.ack).toHaveBeenCalledTimes(1);
  });

  it("acks storefront cache purge messages after the purge endpoint succeeds", async () => {
    mocks.createStorefrontCacheWarmMessageForPurge.mockReturnValue({
      type: "storefront.cache_warm",
      operationId: "purge_op_1",
      paths: ["/products/fish"],
      source: "catalog:products:warm",
      requestedAt: 1_790_000_000_001,
    });
    const message = createMessage<StorefrontCacheQueueMessage>({
      type: "storefront.cache_purge",
      operationId: "purge_op_1",
      groups: ["products"],
      prefixes: ["product_slug_fish"],
      exactKeys: ["product_variants_prod_1"],
      htmlPaths: ["/products/fish"],
      bumpVersion: false,
      source: "catalog:products",
      requestedAt: 1_790_000_000_000,
    });

    await handleQueueBatch(createBatch([message], "storefront-cache"), {
      PURGE_URL: "https://storefront.example.test/api/purge-cache",
      PURGE_TOKEN: "secret",
    } as Env);

    expect(mocks.purgeStorefrontForPrefixes).toHaveBeenCalledWith(
      ["product_slug_fish"],
      expect.objectContaining({
        PURGE_URL: "https://storefront.example.test/api/purge-cache",
        PURGE_TOKEN: "secret",
      }),
      {
        groups: ["products"],
        bumpVersion: false,
        exactKeys: ["product_variants_prod_1"],
        htmlPaths: ["/products/fish"],
        operationId: "purge_op_1",
        warm: false,
      },
    );
    expect(mocks.enqueueStorefrontCacheWarm).toHaveBeenCalledWith(
      {
        type: "storefront.cache_warm",
        operationId: "purge_op_1",
        paths: ["/products/fish"],
        source: "catalog:products:warm",
        requestedAt: 1_790_000_000_001,
      },
      expect.objectContaining({
        PURGE_URL: "https://storefront.example.test/api/purge-cache",
        PURGE_TOKEN: "secret",
      }),
    );
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("acks storefront cache warm messages after warm paths succeed", async () => {
    const message = createMessage<StorefrontCacheQueueMessage>({
      type: "storefront.cache_warm",
      operationId: "purge_op_3",
      paths: ["/", "/products/fish"],
      source: "catalog:products:warm",
      requestedAt: 1_790_000_000_000,
    });

    await handleQueueBatch(createBatch([message], "storefront-cache"), {
      PURGE_URL: "https://storefront.example.test/api/purge-cache",
      PURGE_TOKEN: "secret",
    } as Env);

    expect(mocks.warmStorefrontHtmlPaths).toHaveBeenCalledWith(
      ["/", "/products/fish"],
      expect.objectContaining({
        PURGE_URL: "https://storefront.example.test/api/purge-cache",
        PURGE_TOKEN: "secret",
      }),
    );
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("retries only storefront cache warm messages when warm paths have retryable failures", async () => {
    mocks.warmStorefrontHtmlPaths.mockResolvedValue({
      attempted: true,
      ok: false,
      paths: ["/products/fish"],
      successful: 0,
      skipped: 0,
      retryableFailures: ["/products/fish (503)"],
      skippedFailures: [],
    });
    const message = createMessage<StorefrontCacheQueueMessage>({
      type: "storefront.cache_warm",
      operationId: "purge_op_4",
      paths: ["/products/fish"],
      source: "catalog:products:warm",
      requestedAt: 1_790_000_000_000,
    });

    await handleQueueBatch(createBatch([message], "storefront-cache"), {} as Env);

    expect(mocks.purgeStorefrontForPrefixes).not.toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
  });

  it("retries storefront cache purge messages when the purge endpoint fails", async () => {
    mocks.purgeStorefrontForPrefixes.mockResolvedValue({
      attempted: true,
      ok: false,
      status: 503,
    });
    const message = createMessage<StorefrontCacheQueueMessage>({
      type: "storefront.cache_purge",
      operationId: "purge_op_2",
      groups: ["checkout"],
      prefixes: ["checkout_config"],
      bumpVersion: false,
      source: "api-groups",
      requestedAt: 1_790_000_000_000,
    });

    await handleQueueBatch(createBatch([message], "storefront-cache"), {} as Env);

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
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

  it("marks durable order notifications failed and acks so D1 owns retry timing when dispatch throws", async () => {
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
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("marks durable order notifications failed without immediate queue retry when receipt outcomes need retry", async () => {
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
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("still uses Cloudflare queue retry for legacy order notifications without an outbox id", async () => {
    mocks.sendOrderNotificationEmail.mockRejectedValue(new Error("email provider down"));
    const message = createMessage({
      type: "order.notification",
      orderId: "order-legacy-fail",
      customerName: "Legacy Fail Customer",
      notificationType: "order_cancelled",
    });

    await handleQueueBatch(createBatch([message]), {} as Env);

    expect(mocks.markOrderNotificationOutboxProcessingFailed).not.toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
  });

  it("archives order notification DLQ messages back to the durable outbox", async () => {
    const message = createMessage({
      type: "order.notification",
      outboxId: "outbox_dlq",
      orderId: "order-dlq",
      customerName: "DLQ Customer",
      notificationType: "order_created",
    }, 4);

    await handleQueueBatch(createBatch([message], "order-notifications-dlq") as never, {} as Env);

    expect(mocks.markOrderNotificationOutboxDeadLettered).toHaveBeenCalledWith({
      db: { id: "db" },
      outboxId: "outbox_dlq",
      error: expect.stringContaining("order_notification_dlq_terminal"),
    });
    expect(mocks.sendOrderNotificationEmail).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("acks legacy order notification DLQ messages without provider work", async () => {
    const message = createMessage({
      type: "order.notification",
      orderId: "order-legacy-dlq",
      customerName: "Legacy DLQ Customer",
      notificationType: "order_cancelled",
    }, 4);

    await handleQueueBatch(createBatch([message], "order-notifications-dlq") as never, {} as Env);

    expect(mocks.markOrderNotificationOutboxDeadLettered).not.toHaveBeenCalled();
    expect(mocks.sendOrderNotificationEmail).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
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

  it("keeps OTP identifiers and codes out of generic queue batch event logs", async () => {
    const message = createMessage({
      type: "auth.send_otp",
      deliveryKey: "otp_delivery_private",
      otpExpiresAt: 4_102_444_800,
      method: "email",
      allowedMethod: "email",
      identifier: "private-buyer@example.com",
      code: "987654",
      name: "Private Buyer",
    } as const);

    await handleQueueBatch(createBatch([message], "auth-otp"), {
      CREDENTIAL_ENCRYPTION_KEY: "credential-key",
    } as Env);

    const batchEventLogs = vi.mocked(console.log).mock.calls
      .map(([entry]) => String(entry))
      .filter((entry) => entry.includes("event=queue_batch_"));
    const allQueueLogs = [
      ...vi.mocked(console.log).mock.calls,
      ...vi.mocked(console.warn).mock.calls,
      ...vi.mocked(console.error).mock.calls,
    ].map(([entry]) => String(entry)).join("\n");

    expect(batchEventLogs.length).toBeGreaterThan(0);
    expect(batchEventLogs.join("\n")).not.toContain("private-buyer@example.com");
    expect(batchEventLogs.join("\n")).not.toContain("987654");
    expect(allQueueLogs).not.toContain("private-buyer@example.com");
    expect(allQueueLogs).not.toContain("987654");
  });

  it("skips OTP email when providers fall back to local logging", async () => {
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

    expect(mocks.markNotificationProviderBlocked).toHaveBeenCalledWith(
      { id: "db" },
      {
        channel: "email",
        provider: "email",
        reason: "No configured email provider available; email not delivered",
      },
    );
    expect(mocks.markAuthOtpDeliveryReceiptSkipped).toHaveBeenCalledWith(
      { id: "db" },
      expect.objectContaining({ id: "aor_1", claimId: "aorc_1" }),
      "No configured email provider available; email not delivered",
      {
        provider: "log",
        providerMessageId: undefined,
        providerStatus: "No configured email provider available; email not delivered",
      },
    );
    expect(mocks.markAuthOtpDeliveryReceiptFailed).not.toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
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

  it("skips and blocks SMS OTP when provider credentials are rejected", async () => {
    const smsProvider = {
      name: "smsnetbd",
      validateConfig: vi.fn(() => null),
      sendSms: vi.fn().mockResolvedValue({
        success: false,
        rawStatus: "error=405: Authorization required",
        retryable: false,
      }),
    };
    mocks.getActiveSmsProvider.mockResolvedValue(smsProvider);
    const message = createMessage({
      type: "auth.send_otp",
      deliveryKey: "otp_delivery_sms_bad_creds",
      otpExpiresAt: 4_102_444_800,
      method: "phone",
      allowedMethod: "sms_otp",
      identifier: "+8801712345678",
      code: "654321",
      name: "Buyer",
    } as const);

    await handleQueueBatch(createBatch([message]), {} as Env);

    expect(smsProvider.sendSms).toHaveBeenCalledTimes(1);
    expect(mocks.markNotificationProviderBlocked).toHaveBeenCalledWith(
      { id: "db" },
      {
        channel: "sms",
        provider: "smsnetbd",
        reason: "error=405: Authorization required",
      },
    );
    expect(mocks.markAuthOtpDeliveryReceiptSkipped).toHaveBeenCalledWith(
      { id: "db" },
      expect.objectContaining({ id: "aor_1", claimId: "aorc_1" }),
      "error=405: Authorization required",
      {
        provider: "smsnetbd",
        providerMessageId: undefined,
        providerStatus: "error=405: Authorization required",
        rawResponse: undefined,
      },
    );
    expect(mocks.markAuthOtpDeliveryReceiptFailed).not.toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it("skips SMS OTP provider calls while provider is blocked until settings save", async () => {
    const smsProvider = {
      name: "smsnetbd",
      validateConfig: vi.fn(() => null),
      sendSms: vi.fn(),
    };
    mocks.getActiveSmsProvider.mockResolvedValue(smsProvider);
    mocks.getNotificationProviderBlock.mockResolvedValueOnce({
      channel: "sms",
      provider: "smsnetbd",
      reason: "error=405: Authorization required",
      blockedAt: 1_800,
    });
    const message = createMessage({
      type: "auth.send_otp",
      deliveryKey: "otp_delivery_sms_blocked",
      otpExpiresAt: 4_102_444_800,
      method: "phone",
      allowedMethod: "sms_otp",
      identifier: "+8801712345678",
      code: "654321",
      name: "Buyer",
    } as const);

    await handleQueueBatch(createBatch([message]), {} as Env);

    expect(smsProvider.sendSms).not.toHaveBeenCalled();
    expect(mocks.markNotificationProviderBlocked).not.toHaveBeenCalled();
    expect(mocks.markAuthOtpDeliveryReceiptSkipped).toHaveBeenCalledWith(
      { id: "db" },
      expect.objectContaining({ id: "aor_1", claimId: "aorc_1" }),
      "provider_blocked_until_settings_save: error=405: Authorization required",
      {
        provider: "smsnetbd",
        providerMessageId: undefined,
        providerStatus: "provider_blocked_until_settings_save",
        rawResponse: "error=405: Authorization required",
      },
    );
    expect(mocks.markAuthOtpDeliveryReceiptFailed).not.toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it("retries busy OTP receipts using the receipt backoff hint", async () => {
    mocks.claimAuthOtpDeliveryReceipt.mockResolvedValueOnce({
      claimed: false,
      reason: "busy",
      retryAfterSeconds: 240,
    });
    const message = createMessage({
      type: "auth.send_otp",
      deliveryKey: "otp_delivery_busy",
      otpExpiresAt: 4_102_444_800,
      method: "email",
      allowedMethod: "email",
      identifier: "buyer@example.com",
      code: "123456",
      name: "Buyer",
    } as const);

    await handleQueueBatch(createBatch([message], "auth-otp"), {} as Env);

    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 240 });
  });

  it("stores accepted OTP provider results when the accepted receipt write fails", async () => {
    mocks.markAuthOtpDeliveryReceiptAccepted.mockRejectedValue(new Error("D1 queue overloaded"));
    const cache = {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const message = createMessage({
      type: "auth.send_otp",
      deliveryKey: "otp_delivery_accept_write_fail",
      otpExpiresAt: 4_102_444_800,
      method: "email",
      allowedMethod: "email",
      identifier: "private-buyer@example.com",
      code: "987654",
      name: "Private Buyer",
    } as const);

    await handleQueueBatch(createBatch([message], "auth-otp"), { CACHE: cache } as unknown as Env);

    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.markAuthOtpDeliveryReceiptAccepted).toHaveBeenCalledTimes(3);
    expect(mocks.markAuthOtpDeliveryReceiptFailed).not.toHaveBeenCalled();
    expect(cache.put).toHaveBeenCalledWith(
      "auth_otp:accepted:otp_delivery_accept_write_fail",
      expect.any(String),
      { expirationTtl: 86_400 },
    );
    const hintPayload = String(cache.put.mock.calls[0]?.[1] ?? "");
    expect(hintPayload).toContain("\"provider\":\"cloudflare\"");
    expect(hintPayload).toContain("\"providerMessageId\":\"cf_msg_1\"");
    expect(hintPayload).not.toContain("private-buyer@example.com");
    expect(hintPayload).not.toContain("987654");
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
  });

  it("recovers accepted OTP deliveries from a hint before retrying providers", async () => {
    mocks.claimAuthOtpDeliveryReceipt.mockResolvedValueOnce({
      claimed: false,
      reason: "busy",
      retryAfterSeconds: 240,
    });
    const cache = {
      get: vi.fn().mockResolvedValue({
        deliveryKey: "otp_delivery_accept_recover",
        channel: "email",
        provider: "cloudflare",
        providerMessageId: "cf_msg_1",
        providerStatus: "accepted",
        rawResponse: null,
        createdAt: 1_800,
      }),
      put: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const message = createMessage({
      type: "auth.send_otp",
      deliveryKey: "otp_delivery_accept_recover",
      otpExpiresAt: 4_102_444_800,
      method: "email",
      allowedMethod: "email",
      identifier: "private-buyer@example.com",
      code: "987654",
      name: "Private Buyer",
    } as const);

    await handleQueueBatch(createBatch([message], "auth-otp"), { CACHE: cache } as unknown as Env);

    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.markAuthOtpDeliveryReceiptAcceptedByDeliveryKey).toHaveBeenCalledWith(
      { id: "db" },
      expect.objectContaining({
        deliveryKey: "otp_delivery_accept_recover",
        channel: "email",
        identifierHash: "recipient_hash_1",
      }),
      {
        deliveryKey: "otp_delivery_accept_recover",
        channel: "email",
        provider: "cloudflare",
        providerMessageId: "cf_msg_1",
        providerStatus: "accepted",
        rawResponse: null,
        createdAt: 1_800,
      },
    );
    expect(cache.delete).toHaveBeenCalledWith("auth_otp:accepted:otp_delivery_accept_recover");
    expect(message.retry).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it("archives auth OTP DLQ messages without calling delivery providers", async () => {
    const message = createMessage({
      type: "auth.send_otp",
      deliveryKey: "otp_delivery_dlq",
      otpExpiresAt: 4_102_444_800,
      method: "phone",
      allowedMethod: "sms_otp",
      identifier: "+8801712345678",
      code: "654321",
      name: "Buyer",
    } as const, 6);

    await handleQueueBatch(createBatch([message], "auth-otp-dlq"), {} as Env);

    expect(mocks.getActiveSmsProvider).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.sendWhatsAppTemplateMessage).not.toHaveBeenCalled();
    expect(mocks.markAuthOtpDeliveryReceiptSkippedByDeliveryKey).toHaveBeenCalledWith(
      { id: "db" },
      expect.objectContaining({
        deliveryKey: "otp_delivery_dlq",
        channel: "sms",
        identifierHash: "recipient_hash_1",
      }),
      "auth_otp_dlq_terminal",
      {
        provider: "sms",
        providerStatus: "auth_otp_dlq_terminal",
        rawResponse: expect.stringContaining("attempts=6"),
      },
    );
    const allQueueLogs = [
      ...vi.mocked(console.log).mock.calls,
      ...vi.mocked(console.warn).mock.calls,
      ...vi.mocked(console.error).mock.calls,
    ].map(([entry]) => String(entry)).join("\n");
    expect(allQueueLogs).not.toContain("+8801712345678");
    expect(allQueueLogs).not.toContain("654321");
    expect(message.retry).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it("recovers accepted auth OTP DLQ messages from hints without calling providers", async () => {
    const cache = {
      get: vi.fn().mockResolvedValue({
        deliveryKey: "otp_delivery_dlq_accepted",
        channel: "whatsapp",
        provider: "whatsapp",
        providerMessageId: "wamid.otp.1",
        providerStatus: "accepted",
        rawResponse: "{\"messageId\":\"wamid.otp.1\"}",
        createdAt: 1_800,
      }),
      put: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const message = createMessage({
      type: "auth.send_otp",
      deliveryKey: "otp_delivery_dlq_accepted",
      otpExpiresAt: 4_102_444_800,
      method: "phone",
      allowedMethod: "whatsapp_otp",
      channel: "whatsapp",
      identifier: "+8801712345678",
      code: "654321",
      name: "Buyer",
    } as const, 6);

    await handleQueueBatch(createBatch([message], "auth-otp-dlq"), { CACHE: cache } as unknown as Env);

    expect(mocks.getWhatsAppCloudApiSettings).not.toHaveBeenCalled();
    expect(mocks.sendWhatsAppTemplateMessage).not.toHaveBeenCalled();
    expect(mocks.markAuthOtpDeliveryReceiptSkippedByDeliveryKey).not.toHaveBeenCalled();
    expect(mocks.markAuthOtpDeliveryReceiptAcceptedByDeliveryKey).toHaveBeenCalledWith(
      { id: "db" },
      expect.objectContaining({
        deliveryKey: "otp_delivery_dlq_accepted",
        channel: "whatsapp",
        identifierHash: "recipient_hash_1",
      }),
      {
        deliveryKey: "otp_delivery_dlq_accepted",
        channel: "whatsapp",
        provider: "whatsapp",
        providerMessageId: "wamid.otp.1",
        providerStatus: "accepted",
        rawResponse: "{\"messageId\":\"wamid.otp.1\"}",
        createdAt: 1_800,
      },
    );
    expect(cache.delete).toHaveBeenCalledWith("auth_otp:accepted:otp_delivery_dlq_accepted");
    expect(message.retry).not.toHaveBeenCalled();
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
