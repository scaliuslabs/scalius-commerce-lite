import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(() => ({ id: "db" })),
  processPaymentConfirmed: vi.fn(),
  processPaymentFailed: vi.fn(),
  processExistingMetaPurchaseOutboxForOrder: vi.fn(),
  releaseOrderInventory: vi.fn(),
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
  getCredentialEncryptionKey: vi.fn(() => "credential-key"),
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
  readStoreIdentity: vi.fn(),
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

vi.mock("@scalius/core/modules/notifications/store-messages", async (importOriginal) => ({
  ...await importOriginal<typeof import("@scalius/core/modules/notifications/store-messages")>(),
  readStoreIdentity: mocks.readStoreIdentity,
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
  getCredentialEncryptionKey: mocks.getCredentialEncryptionKey,
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

import {
  handleQueueBatch,
  type PaymentQueueMessage,
} from "./queue-consumer";
import { deriveCustomerAuthOtpDeliveryCode } from "@scalius/core/modules/customers/customer-auth.service";
import { customerAuthOtpChallenges, orderPaymentRecoveryChallenges } from "@scalius/database/schema";
import { encodeEncryptedCredential, encryptCredentials } from "@scalius/core/utils/credential-encryption";

const otpDeliveryCredentialKey = Buffer.alloc(32, 6).toString("base64");
const otpIdentifierHash = "0123456789abcdef".repeat(4);

function createMessage(body: PaymentQueueMessage, attempts?: number): Message<PaymentQueueMessage>;
function createMessage<T>(body: T, attempts?: number): Message<T>;
function createMessage<T>(body: T, attempts = 1): Message<T> {
  const record = body as Record<string, unknown>;
  return {
    id: `msg-${String(record.type)}-${String(record.orderId ?? (record.event as { orderId?: string } | undefined)?.orderId ?? "no-order")}`,
    timestamp: new Date("2026-01-01T00:00:00Z"),
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function createBatch<T>(
  messages: Array<Message<T>>,
  queue = "jobs",
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

async function encryptOtpDeliveryValue(value: string): Promise<string> {
  return encodeEncryptedCredential(await encryptCredentials(value, otpDeliveryCredentialKey));
}

function createOtpChallengeDb(row: {
  deliveryTargetEncrypted: string | null;
  deliveryNameEncrypted: string | null;
  method: "email" | "phone";
  channel: "email" | "sms" | "whatsapp";
  expiresAt: number;
} | null) {
  const tables: unknown[] = [];
  return {
    id: "db",
    tables,
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        tables.push(table);
        return {
          where: vi.fn(() => ({
            get: vi.fn(async () => row),
          })),
        };
      }),
    })),
  };
}

describe("handleQueueBatch payment confirmation retries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCredentialEncryptionKey.mockReturnValue("credential-key");
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
    });
    mocks.sendWhatsAppTemplateMessage.mockResolvedValue({
      success: true,
      providerRef: "wamid.otp.1",
      rawStatus: "accepted",
      rawResponse: JSON.stringify({ messageId: "wamid.otp.1", messageStatus: "accepted" }),
    });
    mocks.getActiveSmsProvider.mockResolvedValue(null);
    mocks.readStoreIdentity.mockResolvedValue({ name: "River & Loom", logoUrl: null, language: "en" });
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
      identifierHash: otpIdentifierHash,
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
    mocks.processExistingMetaPurchaseOutboxForOrder.mockResolvedValue({
      outboxId: "mcap_order_1",
      missing: false,
      processed: true,
      status: "sent",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries unsupported message types instead of acknowledging and losing them", async () => {
    const message = createMessage({ type: "extension.order.created" });

    await handleQueueBatch(
      createBatch([message]) as unknown as MessageBatch<PaymentQueueMessage>,
      {} as Env,
    );

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(console.warn).toHaveBeenCalledWith(
      "[Queue] Unsupported message type:",
      "extension.order.created",
    );
  });

  it("retries confirmed payment messages when processing returns an unsuccessful result", async () => {
    mocks.processPaymentConfirmed.mockResolvedValue({ success: false, error: "D1 batch failed" });

    const messages = [
      createMessage({
        type: "payment.event",
        provider: "stripe",
        event: {
          kind: "confirmed",
          orderId: "order-stripe",
          providerRef: "pi_123",
          amountMinor: 12345,
          currency: "USD",
          eventType: "test",
          eventId: "evt",
        },
      }),
      createMessage({
        type: "payment.event",
        provider: "sslcommerz",
        event: {
          kind: "confirmed",
          orderId: "order-ssl",
          providerRef: "val_123",
          secondaryRef: "bank_123",
          amountMinor: 120000,
          currency: "BDT",
          eventType: "test",
          eventId: "evt",
        },
      }),
    ];

    await handleQueueBatch(createBatch(messages), {} as Env);

    expect(mocks.processPaymentConfirmed).toHaveBeenCalledTimes(2);
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
        type: "payment.event",
        provider: "stripe",
        event: {
          kind: "confirmed",
          orderId,
          providerRef: `pi_${orderId}`,
          amountMinor: 1000,
          currency: "BDT",
          eventType: "test",
          eventId: "evt",
        },
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
      expect.stringContaining("queue=jobs, messages=4, acked=3, retried=1"),
    );
  });

  it("acks confirmed payment messages when processing succeeds", async () => {
    mocks.processPaymentConfirmed.mockResolvedValue({ success: true });
    const notificationQueue = { send: vi.fn(async () => undefined) };

    const message = createMessage({
      type: "payment.event",
      provider: "stripe",
      event: {
        kind: "confirmed",
        orderId: "order-stripe",
        providerRef: "pi_123",
        amountMinor: 12345,
        currency: "USD",
        eventType: "test",
        eventId: "evt",
      },
    });

    await handleQueueBatch(createBatch([message]), {
      JOBS_QUEUE: notificationQueue,
    } as unknown as Env);

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
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

  it("acks duplicate confirmations without repeating availability, notification, or analytics side effects", async () => {
    mocks.processPaymentConfirmed.mockResolvedValue({
      success: true,
      alreadyProcessed: true,
    });
    const message = createMessage({
      type: "payment.event",
      provider: "stripe",
      event: {
        kind: "confirmed",
        orderId: "order-stripe",
        providerRef: "pi_123",
        amountMinor: 12345,
        currency: "USD",
        eventType: "test",
        eventId: "evt",
      },
    });

    await handleQueueBatch(createBatch([message]), {} as Env);

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
    expect(mocks.enqueueOrderCreatedNotificationForOrder).not.toHaveBeenCalled();
    expect(mocks.enqueueOrderBalancePaidNotificationForOrder).not.toHaveBeenCalled();
    expect(mocks.processExistingMetaPurchaseOutboxForOrder).not.toHaveBeenCalled();
  });

  it("enqueues balance-paid notifications instead of order-created notifications for balance payments", async () => {
    mocks.processPaymentConfirmed.mockResolvedValue({ success: true });
    const notificationQueue = { send: vi.fn(async () => undefined) };

    const message = createMessage({
      type: "payment.event",
      provider: "sslcommerz",
      event: {
        kind: "confirmed",
        orderId: "order-balance",
        providerRef: "val_balance",
        secondaryRef: "bank_balance",
        amountMinor: 75000,
        currency: "BDT",
        paymentType: "balance",
        eventType: "test",
        eventId: "evt",
      },
    });

    await handleQueueBatch(createBatch([message]), {
      JOBS_QUEUE: notificationQueue,
    } as unknown as Env);

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(mocks.processPaymentConfirmed).toHaveBeenCalledWith(
      { id: "db" },
      expect.objectContaining({
        orderId: "order-balance",
        provider: "sslcommerz",
        paymentType: "balance",
        amountMinor: 75_000,
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
      type: "payment.event",
      provider: "stripe",
      event: {
        kind: "confirmed",
        orderId: "order-stripe-balance",
        providerRef: "pi_balance",
        amountMinor: 6500,
        currency: "BDT",
        paymentType: "balance",
        eventType: "test",
        eventId: "evt",
      },
    });

    await handleQueueBatch(createBatch([message]), {
      JOBS_QUEUE: notificationQueue,
    } as unknown as Env);

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(mocks.processPaymentConfirmed).toHaveBeenCalledWith(
      { id: "db" },
      expect.objectContaining({
        orderId: "order-stripe-balance",
        provider: "stripe",
        paymentType: "balance",
        amountMinor: 6_500,
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

  it("keeps Stripe refund webhooks audit-only until scheduled reconciliation imports them", async () => {
    const message = createMessage({
      type: "payment.event",
      webhookEventId: "stripe:charge-refunded:evt_refund",
      provider: "stripe",
      event: {
        kind: "refund_observed",
        orderId: "order-stripe",
        providerRef: "pi_stripe",
        secondaryRef: "ch_stripe",
        details: { amountRefunded: 1500, currency: "BDT" },
        eventType: "test",
        eventId: "evt",
      },
    });

    await handleQueueBatch(createBatch([message]), {} as Env);

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueOrderRefundNotificationForOrder).not.toHaveBeenCalled();
    expect(mocks.markWebhookEventProcessed).not.toHaveBeenCalled();
    expect(mocks.markWebhookEventManualReconciliation).toHaveBeenCalledWith(
      { id: "db" },
      "stripe:charge-refunded:evt_refund",
      expect.objectContaining({
        queueType: "payment.event",
        orderId: "order-stripe",
        gateway: "stripe",
        outcome: "external_refund_observed",
        amountRefunded: 1500,
        currency: "BDT",
        providerRef: "pi_stripe",
        secondaryRef: "ch_stripe",
      }),
    );
  });

  it("marks webhook events processed after confirmed payment side effects succeed", async () => {
    mocks.processPaymentConfirmed.mockResolvedValue({ success: true });
    const notificationQueue = { send: vi.fn(async () => undefined) };

    const message = createMessage({
      type: "payment.event",
      webhookEventId: "stripe:payment_intent.succeeded:evt_1",
      provider: "stripe",
      event: {
        kind: "confirmed",
        orderId: "order-stripe",
        providerRef: "pi_123",
        amountMinor: 12345,
        currency: "USD",
        eventType: "test",
        eventId: "evt",
      },
    });

    await handleQueueBatch(createBatch([message]), {
      JOBS_QUEUE: notificationQueue,
    } as unknown as Env);

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(mocks.markWebhookEventProcessed).toHaveBeenCalledWith(
      { id: "db" },
      "stripe:payment_intent.succeeded:evt_1",
      expect.objectContaining({
        queueMessageId: message.id,
        queueType: "payment.event",
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
      type: "payment.event",
      webhookEventId: "stripe:payment_intent.succeeded:evt_late",
      provider: "stripe",
      event: {
        kind: "confirmed",
        orderId: "order-stripe",
        providerRef: "pi_late",
        amountMinor: 12345,
        currency: "USD",
        eventType: "test",
        eventId: "evt",
      },
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
        queueType: "payment.event",
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
      type: "payment.event",
      webhookEventId: "stripe:payment_intent.succeeded:evt_retry",
      provider: "stripe",
      event: {
        kind: "confirmed",
        orderId: "order-stripe",
        providerRef: "pi_retry",
        amountMinor: 12345,
        currency: "USD",
        eventType: "test",
        eventId: "evt",
      },
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
      type: "payment.event",
      webhookEventId: "stripe:payment_intent.succeeded:evt_terminal",
      provider: "stripe",
      event: {
        kind: "confirmed",
        orderId: "order-stripe",
        providerRef: "pi_terminal",
        amountMinor: 12345,
        currency: "USD",
        eventType: "test",
        eventId: "evt",
      },
    }, 6);

    await handleQueueBatch(createBatch([message]), {} as Env);

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(mocks.markWebhookEventFailed).toHaveBeenCalledWith(
      { id: "db" },
      "stripe:payment_intent.succeeded:evt_terminal",
      expect.objectContaining({
        queueMessageId: message.id,
        queueType: "payment.event",
        orderId: "order-stripe",
        terminalDeliveryAttempt: 6,
        maxRetries: 5,
        error: "stripe payment confirmation failed for order order-stripe: D1 batch failed",
      }),
    );
    expect(mocks.markWebhookEventProcessed).not.toHaveBeenCalled();
  });

  it("archives payment DLQ messages without reprocessing payment side effects", async () => {
    const message = createMessage({
      type: "payment.event",
      webhookEventId: "stripe:payment_intent.succeeded:evt_dlq",
      provider: "stripe",
      event: {
        kind: "confirmed",
        orderId: "order-stripe",
        providerRef: "pi_dlq",
        amountMinor: 12345,
        currency: "USD",
        paymentType: "deposit",
        eventType: "test",
        eventId: "evt",
      },
    }, 5);

    await handleQueueBatch(createBatch([message], "jobs-dlq") as never, {} as Env);

    expect(mocks.processPaymentConfirmed).not.toHaveBeenCalled();
    expect(mocks.markWebhookEventProcessed).not.toHaveBeenCalled();
    expect(mocks.markWebhookEventFailed).not.toHaveBeenCalled();
    expect(mocks.recordPaymentWebhookDlqEvidence).toHaveBeenCalledWith(
      { id: "db" },
      expect.objectContaining({
        webhookEventId: "stripe:payment_intent.succeeded:evt_dlq",
        provider: "stripe",
        eventType: "payment.event.confirmed",
        orderId: "order-stripe",
        queueMessageId: message.id,
        queueType: "payment.event",
        attempts: 5,
        messageTimestampSeconds: 1_767_225_600,
        payment: {
          kind: "confirmed",
          providerRef: "pi_dlq",
          secondaryRef: null,
          amountMinor: 12345,
          currency: "USD",
          paymentType: "deposit",
        },
      }),
    );
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("archives each type in one mixed jobs-dlq batch into its own durable row", async () => {
    const payment = createMessage({
      type: "payment.event",
      webhookEventId: "stripe:payment_intent.succeeded:evt_mixed",
      provider: "stripe",
      event: {
        kind: "confirmed",
        orderId: "order-mixed",
        providerRef: "pi_mixed",
        amountMinor: 100,
        currency: "USD",
        eventType: "test",
        eventId: "evt",
      },
    }, 6);
    const notification = createMessage({
      type: "order.notification",
      outboxId: "outbox_mixed",
      orderId: "order-mixed",
      customerName: "Mixed Customer",
      notificationType: "order_created",
    }, 6);
    const unknown = createMessage({ type: "meta.purchase", orderId: "order-mixed" }, 6);

    await handleQueueBatch(
      createBatch([payment, notification, unknown] as Array<Message<Record<string, unknown>>>, "jobs-dlq") as never,
      {} as Env,
    );

    expect(mocks.recordPaymentWebhookDlqEvidence).toHaveBeenCalledTimes(1);
    expect(mocks.markOrderNotificationOutboxDeadLettered).toHaveBeenCalledWith(
      expect.objectContaining({ outboxId: "outbox_mixed" }),
    );
    expect(mocks.processPaymentConfirmed).not.toHaveBeenCalled();
    expect(mocks.sendOrderNotificationEmail).not.toHaveBeenCalled();
    for (const message of [payment, notification, unknown]) {
      expect(message.ack).toHaveBeenCalledTimes(1);
      expect(message.retry).not.toHaveBeenCalled();
    }
  });

  it("retries payment DLQ messages when evidence persistence fails", async () => {
    mocks.recordPaymentWebhookDlqEvidence.mockRejectedValueOnce(new Error("D1 unavailable"));
    const message = createMessage({
      type: "payment.event",
      webhookEventId: "sslcommerz:ipn:tran:val",
      provider: "sslcommerz",
      event: {
        kind: "confirmed",
        orderId: "order-ssl",
        providerRef: "val_123",
        secondaryRef: "bank_123",
        amountMinor: 120000,
        currency: "BDT",
        paymentType: "full",
        eventType: "test",
        eventId: "evt",
      },
    }, 5);

    await handleQueueBatch(createBatch([message], "jobs-dlq") as never, {} as Env);

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
        type: "payment.event",
        webhookEventId: `stripe:payment_intent.succeeded:${orderId}`,
        provider: "stripe",
        event: {
          kind: "confirmed",
          orderId,
          providerRef: `pi_${orderId}`,
          amountMinor: 1000,
          currency: "BDT",
          eventType: "test",
          eventId: "evt",
        },
      }, 5),
    );

    const run = handleQueueBatch(createBatch(messages, "jobs-dlq") as never, {} as Env);
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
      expect.stringContaining("queue=jobs-dlq, messages=3, acked=2, retried=1"),
    );
  });

  it("retries confirmed payment messages when order-created notification enqueue fails", async () => {
    mocks.processPaymentConfirmed.mockResolvedValue({ success: true });
    mocks.enqueueOrderCreatedNotificationForOrder.mockRejectedValue(new Error("queue unavailable"));

    const message = createMessage({
      type: "payment.event",
      provider: "sslcommerz",
      event: {
        kind: "confirmed",
        orderId: "order-ssl",
        providerRef: "val_123",
        secondaryRef: "bank_123",
        amountMinor: 120000,
        currency: "BDT",
        eventType: "test",
        eventId: "evt",
      },
    });

    await handleQueueBatch(createBatch([message]), {} as Env);

    expect(mocks.processPaymentConfirmed).toHaveBeenCalledTimes(1);
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
      type: "payment.event",
      provider: "stripe",
      event: {
        kind: "confirmed",
        orderId: "order-balance",
        providerRef: "pi_balance",
        amountMinor: 6500,
        currency: "BDT",
        paymentType: "balance",
        eventType: "test",
        eventId: "evt",
      },
    });

    await handleQueueBatch(createBatch([message]), {} as Env);

    expect(mocks.processPaymentConfirmed).toHaveBeenCalledWith(
      { id: "db" },
      expect.objectContaining({
        orderId: "order-balance",
        provider: "stripe",
        paymentType: "balance",
        amountMinor: 6_500,
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

    expect(mocks.getCredentialEncryptionKey).toHaveBeenCalledTimes(1);
    expect(mocks.sendOrderNotificationEmail).toHaveBeenCalledWith(
      undefined,
      "SMS Customer",
      "order-refunded",
      "order_refunded",
      { reason: "refund" },
      { id: "db" },
      {
        encryptionKey: "credential-key",
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

    await handleQueueBatch(createBatch([message], "jobs-dlq") as never, {} as Env);

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

    await handleQueueBatch(createBatch([message], "jobs-dlq") as never, {} as Env);

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

  it("skips admin push with an ops log instead of inventing an API origin when the platform apiUrl is not configured", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.getAdminNotificationChannels.mockResolvedValue({
      order_shipped: ["push"],
    });
    const message = createMessage({
      type: "order.notification",
      outboxId: "outbox_push_unconfigured",
      orderId: "order-shipped-unconfigured",
      customerName: "Push Customer",
      notificationType: "order_shipped",
      data: { trackingId: "TRK-2" },
    });

    await handleQueueBatch(createBatch([message]), {} as Env);

    expect(mocks.sendOrderNotification).not.toHaveBeenCalled();
    const skipLog = warn.mock.calls.find((call) => {
      if (call[0] !== "[api-ops]" || typeof call[1] !== "string") return false;
      return (JSON.parse(call[1]) as { event?: string }).event
        === "queue.order_notification.admin_push_skipped";
    });
    expect(skipLog).toBeTruthy();
    expect(JSON.parse(skipLog?.[1] as string)).toMatchObject({
      event: "queue.order_notification.admin_push_skipped",
      orderId: "order-shipped-unconfigured",
      notificationType: "order_shipped",
      outboxId: "outbox_push_unconfigured",
      reason: expect.stringContaining("Settings -> System -> Platform"),
    });
    expect(warn.mock.calls.map((call) => String(call[1] ?? ""))).not.toContainEqual(
      expect.stringContaining("scalius.com"),
    );
    expect(mocks.markOrderNotificationOutboxSent).toHaveBeenCalledWith(
      { id: "db" },
      "outbox_1",
      "claim_1",
    );
    expect(message.retry).not.toHaveBeenCalled();
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
    const challengeKey = "cust_otp:email:challenge_hash_1";
    const deliveryKey = "otp_delivery_1";
    const db = createOtpChallengeDb({
      deliveryTargetEncrypted: await encryptOtpDeliveryValue("buyer@example.com"),
      deliveryNameEncrypted: await encryptOtpDeliveryValue("Buyer"),
      method: "email",
      channel: "email",
      expiresAt: 4_102_444_800,
    });
    mocks.getDb.mockReturnValueOnce(db);
    // One key: CREDENTIAL_ENCRYPTION_KEY decrypts the D1 delivery target,
    // derives the OTP code, and is handed to the provider dispatch context.
    mocks.getCredentialEncryptionKey.mockReturnValue(otpDeliveryCredentialKey);
    const expectedCode = await deriveCustomerAuthOtpDeliveryCode({
      otpKey: challengeKey,
      deliveryKey,
      encryptionKey: otpDeliveryCredentialKey,
    });
    const message = createMessage({
      type: "auth.send_otp",
      challengeKey,
      deliveryKey,
      purpose: "customer_login",
      otpExpiresAt: 4_102_444_800,
      method: "email",
      allowedMethod: "email",
    } as const);
    expect(JSON.stringify(message.body)).not.toContain(expectedCode);
    expect(JSON.stringify(message.body)).not.toContain("buyer@example.com");
    expect(JSON.stringify(message.body)).not.toContain("Buyer");
    expect(message.body).not.toHaveProperty("code");
    expect(message.body).not.toHaveProperty("identifier");
    expect(message.body).not.toHaveProperty("name");
    const env = {
      EMAIL: {
        send: vi.fn(),
      },
      CREDENTIAL_ENCRYPTION_KEY: otpDeliveryCredentialKey,
    } as unknown as Env;

    await handleQueueBatch(createBatch([message]), env);

    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "buyer@example.com",
        subject: `${expectedCode} is your River & Loom code`,
        fromName: "River & Loom",
        text: expect.stringContaining(`Use this code to sign in or create your account at River & Loom.\n\n${expectedCode}\n\nThis code expires in 5 minutes.`),
        html: expect.stringContaining('<html lang="en">'),
        idempotencyKey: deliveryKey,
      }),
      {
        db,
        env,
        encryptionKey: otpDeliveryCredentialKey,
      },
    );
    expect(mocks.markAuthOtpDeliveryReceiptAccepted).toHaveBeenCalledWith(
      db,
      {
        id: "aor_1",
        deliveryKey,
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

  it("sends payment recovery OTPs after resolving encrypted delivery targets from D1", async () => {
    const challengeKey = "order_payrec:challenge_hash_1";
    const deliveryKey = "otp_delivery_payrec_1";
    const db = createOtpChallengeDb({
      deliveryTargetEncrypted: await encryptOtpDeliveryValue("recovery-buyer@example.com"),
      deliveryNameEncrypted: await encryptOtpDeliveryValue("Recovery Buyer"),
      method: "email",
      channel: "email",
      expiresAt: 4_102_444_800,
    });
    mocks.getDb.mockReturnValueOnce(db);
    // One key: CREDENTIAL_ENCRYPTION_KEY decrypts the D1 delivery target,
    // derives the OTP code, and is handed to the provider dispatch context.
    mocks.getCredentialEncryptionKey.mockReturnValue(otpDeliveryCredentialKey);
    const expectedCode = await deriveCustomerAuthOtpDeliveryCode({
      otpKey: challengeKey,
      deliveryKey,
      encryptionKey: otpDeliveryCredentialKey,
    });
    const message = createMessage({
      type: "auth.send_otp",
      challengeKey,
      deliveryKey,
      purpose: "order_payment_recovery",
      otpExpiresAt: 4_102_444_800,
      method: "email",
      allowedMethod: "email",
      channel: "email",
    } as const);
    expect(JSON.stringify(message.body)).not.toContain("recovery-buyer@example.com");
    expect(JSON.stringify(message.body)).not.toContain("Recovery Buyer");
    expect(JSON.stringify(message.body)).not.toContain(expectedCode);
    expect(message.body).not.toHaveProperty("identifier");
    expect(message.body).not.toHaveProperty("name");
    expect(message.body).not.toHaveProperty("code");

    const env = {
      EMAIL: {
        send: vi.fn(),
      },
      CREDENTIAL_ENCRYPTION_KEY: otpDeliveryCredentialKey,
    } as unknown as Env;

    await handleQueueBatch(createBatch([message]), env);

    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "recovery-buyer@example.com",
        subject: `${expectedCode} is your River & Loom code`,
        text: expect.stringContaining("Use this code to finish paying for your order at River & Loom."),
        idempotencyKey: deliveryKey,
      }),
      {
        db,
        env,
        encryptionKey: otpDeliveryCredentialKey,
      },
    );
    expect(db.tables).toEqual([orderPaymentRecoveryChallenges]);
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it("resolves track-order codes from the order challenge table and names the store in Bangla without a buyer name", async () => {
    const challengeKey = "order_lookup:challenge_hash_1";
    const deliveryKey = "otp_delivery_lookup_1";
    const db = createOtpChallengeDb({
      deliveryTargetEncrypted: await encryptOtpDeliveryValue("lookup-buyer@example.com"),
      deliveryNameEncrypted: null,
      method: "email",
      channel: "email",
      expiresAt: 4_102_444_800,
    });
    mocks.getDb.mockReturnValueOnce(db);
    mocks.getCredentialEncryptionKey.mockReturnValue(otpDeliveryCredentialKey);
    mocks.readStoreIdentity.mockResolvedValue({ name: "River & Loom", logoUrl: null, language: "bn" });
    const expectedCode = await deriveCustomerAuthOtpDeliveryCode({
      otpKey: challengeKey,
      deliveryKey,
      encryptionKey: otpDeliveryCredentialKey,
    });
    const message = createMessage({
      type: "auth.send_otp",
      challengeKey,
      deliveryKey,
      purpose: "order_lookup",
      otpExpiresAt: 4_102_444_800,
      method: "email",
      allowedMethod: "email",
      channel: "email",
    } as const);

    await handleQueueBatch(createBatch([message]), { CREDENTIAL_ENCRYPTION_KEY: otpDeliveryCredentialKey } as unknown as Env);

    expect(db.tables).toEqual([orderPaymentRecoveryChallenges]);
    expect(mocks.readStoreIdentity).toHaveBeenCalledTimes(1);
    const email = mocks.sendEmail.mock.calls[0]![0];
    expect(email).toMatchObject({
      to: "lookup-buyer@example.com",
      subject: `River & Loom-এর কোড ${expectedCode}`,
      fromName: "River & Loom",
    });
    expect(email.html).toContain('<html lang="bn">');
    expect(email.text).toContain("হ্যালো,\n\nRiver & Loom-এ আপনার অর্ডার দেখতে এই কোডটি ব্যবহার করুন।");
    expect(`${email.html}${email.text}`).not.toContain("Customer");
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it("keeps sign-in codes on the customer challenge table and sends them unbranded when settings cannot load", async () => {
    const db = createOtpChallengeDb({
      deliveryTargetEncrypted: await encryptOtpDeliveryValue("buyer@example.com"),
      deliveryNameEncrypted: null,
      method: "email",
      channel: "email",
      expiresAt: 4_102_444_800,
    });
    mocks.getDb.mockReturnValueOnce(db);
    mocks.getCredentialEncryptionKey.mockReturnValue(otpDeliveryCredentialKey);
    mocks.readStoreIdentity.mockRejectedValue(new Error("settings unavailable"));
    const message = createMessage({
      type: "auth.send_otp",
      challengeKey: "cust_otp:email:challenge_hash_2",
      deliveryKey: "otp_delivery_2",
      purpose: "customer_login",
      otpExpiresAt: 4_102_444_800,
      method: "email",
      allowedMethod: "email",
    } as const);

    await handleQueueBatch(createBatch([message]), { CREDENTIAL_ENCRYPTION_KEY: otpDeliveryCredentialKey } as unknown as Env);

    expect(db.tables).toEqual([customerAuthOtpChallenges]);
    const email = mocks.sendEmail.mock.calls[0]![0];
    expect(email.subject).toMatch(/^\d{6} is your verification code$/);
    expect(email.fromName).toBeUndefined();
    expect(email.text).toMatch(/^Hi,\n\nUse this code to sign in or create your account\./);
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it("terminally skips new OTP payloads when the D1 delivery target row is missing", async () => {
    const challengeKey = "cust_otp:email:missing_target";
    const deliveryKey = "otp_delivery_missing_target";
    const db = createOtpChallengeDb(null);
    mocks.getDb.mockReturnValueOnce(db);
    mocks.claimAuthOtpDeliveryReceipt.mockResolvedValueOnce({
      claimed: true,
      receipt: {
        id: "aor_missing_target",
        deliveryKey,
        claimId: "aorc_missing_target",
        attempts: 1,
      },
    });
    const expectedCode = await deriveCustomerAuthOtpDeliveryCode({
      otpKey: challengeKey,
      deliveryKey,
      encryptionKey: "credential-key",
    });
    const message = createMessage({
      type: "auth.send_otp",
      challengeKey,
      deliveryKey,
      purpose: "customer_login",
      otpExpiresAt: 4_102_444_800,
      method: "email",
      allowedMethod: "email",
    } as const);

    await handleQueueBatch(createBatch([message]), {} as Env);

    expect(JSON.stringify(message.body)).not.toContain(expectedCode);
    expect(message.body).not.toHaveProperty("code");
    expect(message.body).not.toHaveProperty("identifier");
    expect(message.body).not.toHaveProperty("name");
    expect(mocks.createAuthOtpDeliveryTarget).toHaveBeenCalledWith(expect.objectContaining({
      deliveryKey,
      identifier: `unresolved:${deliveryKey}`,
    }));
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.getActiveSmsProvider).not.toHaveBeenCalled();
    expect(mocks.sendWhatsAppTemplateMessage).not.toHaveBeenCalled();
    expect(mocks.markAuthOtpDeliveryReceiptSkipped).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ id: "aor_missing_target", deliveryKey }),
      "missing_delivery_target",
      {
        provider: "email",
        providerStatus: "missing_delivery_target",
      },
    );
    expect(mocks.markAuthOtpDeliveryReceiptFailed).not.toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it("terminally skips new OTP payloads when the encrypted D1 delivery target cannot decrypt", async () => {
    const challengeKey = "cust_otp:sms:decrypt_failure";
    const deliveryKey = "otp_delivery_decrypt_failure";
    const db = createOtpChallengeDb({
      deliveryTargetEncrypted: await encryptOtpDeliveryValue("+8801712345678"),
      deliveryNameEncrypted: await encryptOtpDeliveryValue("Decrypt Buyer"),
      method: "phone",
      channel: "sms",
      expiresAt: 4_102_444_800,
    });
    mocks.getDb.mockReturnValueOnce(db);
    mocks.getCredentialEncryptionKey.mockReturnValueOnce(Buffer.alloc(32, 7).toString("base64"));
    mocks.claimAuthOtpDeliveryReceipt.mockResolvedValueOnce({
      claimed: true,
      receipt: {
        id: "aor_decrypt_failure",
        deliveryKey,
        claimId: "aorc_decrypt_failure",
        attempts: 1,
      },
    });
    const expectedCode = await deriveCustomerAuthOtpDeliveryCode({
      otpKey: challengeKey,
      deliveryKey,
      encryptionKey: "credential-key",
    });
    const message = createMessage({
      type: "auth.send_otp",
      challengeKey,
      deliveryKey,
      purpose: "customer_login",
      otpExpiresAt: 4_102_444_800,
      method: "phone",
      allowedMethod: "sms_otp",
    } as const);

    await handleQueueBatch(createBatch([message]), {
      CREDENTIAL_ENCRYPTION_KEY: otpDeliveryCredentialKey,
    } as Env);

    expect(JSON.stringify(message.body)).not.toContain(expectedCode);
    expect(JSON.stringify(message.body)).not.toContain("+8801712345678");
    expect(JSON.stringify(message.body)).not.toContain("Decrypt Buyer");
    expect(message.body).not.toHaveProperty("code");
    expect(message.body).not.toHaveProperty("identifier");
    expect(message.body).not.toHaveProperty("name");
    expect(mocks.createAuthOtpDeliveryTarget).toHaveBeenCalledWith(expect.objectContaining({
      deliveryKey,
      channel: "sms",
      identifier: `unresolved:${deliveryKey}`,
    }));
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.getActiveSmsProvider).not.toHaveBeenCalled();
    expect(mocks.sendWhatsAppTemplateMessage).not.toHaveBeenCalled();
    expect(mocks.markAuthOtpDeliveryReceiptSkipped).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ id: "aor_decrypt_failure", deliveryKey }),
      "delivery_target_decrypt_failed",
      {
        provider: "sms",
        providerStatus: "delivery_target_decrypt_failed",
      },
    );
    expect(mocks.markAuthOtpDeliveryReceiptFailed).not.toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
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

    await handleQueueBatch(createBatch([message], "jobs"), {
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
    expect(allQueueLogs).not.toContain(otpIdentifierHash);
    expect(allQueueLogs).toContain(`recipientHashPrefix=${otpIdentifierHash.slice(0, 12)}`);
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
      message: "654321 is your River & Loom code. It expires in 5 minutes. Don't share it.",
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

    await handleQueueBatch(createBatch([message], "jobs"), {} as Env);

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

    await handleQueueBatch(createBatch([message], "jobs"), { CACHE: cache } as unknown as Env);

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

    await handleQueueBatch(createBatch([message], "jobs"), { CACHE: cache } as unknown as Env);

    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.markAuthOtpDeliveryReceiptAcceptedByDeliveryKey).toHaveBeenCalledWith(
      { id: "db" },
      expect.objectContaining({
        deliveryKey: "otp_delivery_accept_recover",
        channel: "email",
        identifierHash: otpIdentifierHash,
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

    await handleQueueBatch(createBatch([message], "jobs-dlq"), {} as Env);

    expect(mocks.getActiveSmsProvider).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.sendWhatsAppTemplateMessage).not.toHaveBeenCalled();
    expect(mocks.markAuthOtpDeliveryReceiptSkippedByDeliveryKey).toHaveBeenCalledWith(
      { id: "db" },
      expect.objectContaining({
        deliveryKey: "otp_delivery_dlq",
        channel: "sms",
        identifierHash: otpIdentifierHash,
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

    await handleQueueBatch(createBatch([message], "jobs-dlq"), { CACHE: cache } as unknown as Env);

    expect(mocks.getWhatsAppCloudApiSettings).not.toHaveBeenCalled();
    expect(mocks.sendWhatsAppTemplateMessage).not.toHaveBeenCalled();
    expect(mocks.markAuthOtpDeliveryReceiptSkippedByDeliveryKey).not.toHaveBeenCalled();
    expect(mocks.markAuthOtpDeliveryReceiptAcceptedByDeliveryKey).toHaveBeenCalledWith(
      { id: "db" },
      expect.objectContaining({
        deliveryKey: "otp_delivery_dlq_accepted",
        channel: "whatsapp",
        identifierHash: otpIdentifierHash,
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
    const challengeKey = "cust_otp:whatsapp:challenge_hash_1";
    const deliveryKey = "otp_delivery_wa_1";
    const expectedCode = await deriveCustomerAuthOtpDeliveryCode({
      otpKey: challengeKey,
      deliveryKey,
      encryptionKey: "credential-key",
    });
    const message = createMessage({
      type: "auth.send_otp",
      challengeKey,
      deliveryKey,
      otpExpiresAt: 4_102_444_800,
      method: "phone",
      allowedMethod: "whatsapp_otp",
      identifier: "+8801712345678",
      name: "Buyer",
    } as const);
    expect(JSON.stringify(message.body)).not.toContain(expectedCode);
    expect(message.body).not.toHaveProperty("code");

    await handleQueueBatch(createBatch([message]), {} as Env);

    expect(mocks.getWhatsAppCloudApiSettings).toHaveBeenCalledWith({ id: "db" }, "credential-key");
    expect(mocks.sendWhatsAppTemplateMessage).toHaveBeenCalledWith({
      accessToken: "wa_token",
      phoneNumberId: "phone_id_1",
      to: "+8801712345678",
      templateName: "auth_otp",
      languageCode: "en_US",
      bodyParameters: [expectedCode],
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
