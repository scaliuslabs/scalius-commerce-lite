// src/queue-consumer.ts
// Cloudflare Queue consumer — thin dispatcher.
// Receives batches from Cloudflare and routes each message to the right handler.
//
// Architecture:
//   Webhook handler  →  enqueue message  →  return 200 immediately
//   Queue consumer   →  process message  →  update DB, send notifications
//
// This makes webhooks resilient: Cloudflare retries failed queue messages
// automatically (up to max_retries = 3).
//
// Handler locations:
//   order.ingest     → src/modules/orders/orders.queue.ts
//   payment.*        → src/modules/payments/process-payment.ts   (via switch below)
//   order.notif      → src/modules/notifications/notifications.service.ts
//   auth.send_otp    → inline below (WhatsApp + email; SMS providers TBD)
//
// TODO: When 5-6 SMS providers are implemented, extract auth.send_otp to
//       src/modules/notifications/otp.handler.ts

import { getDb } from "@scalius/database/client";
import { processPaymentConfirmed, processPaymentFailed, releaseOrderInventory } from "@scalius/core/modules/payments/process-payment";
import { processPolarWebhookRefund } from "@scalius/core/modules/payments/polar";
import { sendOrderNotificationEmail, sendOrderNotification } from "@scalius/core/modules/notifications/notifications.service";
import { sendEmail } from "@scalius/core/integrations/email";
import { handleOrderIngestBatch, type OrderIngestQueueMessage } from "@scalius/core/modules/orders/orders.queue";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { getActiveSmsProvider } from "@scalius/core/integrations/sms";
import { getEncryptionKey } from "./utils/encryption-key";

// Re-export so webhook routes can import message types from one place.
export type { OrderIngestQueueMessage } from "@scalius/core/modules/orders/orders.queue";

export type PaymentQueueMessage =
  | {
    type: "payment.stripe.confirmed";
    orderId: string;
    paymentIntentId: string;
    amount: number; // in smallest currency unit (cents, yen, fils — see ISO 4217)
    currency: string;
    chargeId?: string;
    metadata?: Record<string, string>;
  }
  | {
    type: "payment.stripe.failed";
    orderId: string;
    paymentIntentId: string;
    failureCode?: string;
    failureMessage?: string;
  }
  | {
    type: "payment.stripe.canceled";
    orderId: string;
    paymentIntentId: string;
  }
  | {
    type: "payment.stripe.refunded";
    orderId: string;
    paymentIntentId: string;
    amountRefunded: number; // in smallest currency unit (cents, yen, fils — see ISO 4217)
    chargeId: string;
  }
  | {
    type: "payment.sslcommerz.confirmed";
    orderId: string;
    tranId: string;
    valId: string;
    bankTranId: string;
    amount: number;
    currency: string;
    cardType?: string;
    cardBrand?: string;
    paymentType?: string;
  }
  | {
    type: "payment.sslcommerz.failed";
    orderId: string;
    tranId: string;
    status: string;
  }
  | {
    type: "payment.polar.confirmed";
    orderId: string;
    checkoutId: string;
    amount?: number; // in smallest currency unit (cents, yen, fils — see ISO 4217)
    currency?: string;
    paymentType?: string;
    metadata?: Record<string, string>;
  }
  | {
    type: "payment.polar.failed";
    orderId: string;
    checkoutId: string;
    reason?: string;
  }
  | {
    type: "payment.polar.refunded";
    orderId: string;
    polarCheckoutId: string;
    amountRefunded: number; // in smallest currency unit (cents) — cumulative refunded amount from Polar
    totalAmount: number; // in smallest currency unit (cents) — original total from Polar
    currency: string;
    polarStatus: string; // "refunded" (full) or "partially_refunded"
  }
  | {
    type: "order.notification";
    orderId: string;
    customerEmail?: string;
    customerName: string;
    notificationType: "order_created" | "order_confirmed" | "order_processing" | "order_shipped" | "order_delivered" | "order_cancelled" | "order_returned";
    data?: Record<string, unknown>;
  };

export type AuthOtpQueueMessage =
  | {
    type: "auth.send_otp";
    method: "email" | "phone";
    allowedMethod: string;
    identifier: string;
    code: string;
    name: string;
    waToken?: string;
    waPhoneId?: string;
    waTemplate?: string;
  };

// ── Queue batch handler ────────────────────────────────────────────────────

/**
 * Handle a batch of queue messages.
 * Each message is processed independently; failures are retried by Cloudflare.
 */
export async function handleQueueBatch(
  batch: MessageBatch<PaymentQueueMessage | AuthOtpQueueMessage | OrderIngestQueueMessage>,
  env: Env,
): Promise<void> {
  const db = getDb(env);

  // Order ingest uses a different strategy: a single db.batch() across all messages
  if (batch.queue === "order-ingest-queue" || batch.messages.some(m => m.body.type === "order.ingest")) {
    await handleOrderIngestBatch(batch as unknown as MessageBatch<OrderIngestQueueMessage>, db, env);
    return;
  }

  // Process each payment/notification/OTP message independently
  const results = await Promise.allSettled(
    batch.messages.map((msg) => processQueueMessage(msg as unknown as Message<PaymentQueueMessage | AuthOtpQueueMessage>, db, env)),
  );

  // Ack successful, retry failed with backoff
  for (let i = 0; i < batch.messages.length; i++) {
    const result = results[i];
    const msg = batch.messages[i];
    if (!result || !msg) continue;
    if (result.status === "fulfilled") {
      msg.ack();
    } else {
      console.error(`[Queue] Failed to process message ${msg.id}:`, result.status === "rejected" ? result.reason : "unknown");
      msg.retry({ delaySeconds: 30 });
    }
  }
}

// ── Single message processor ───────────────────────────────────────────────

/**
 * Process a single payment, notification, or OTP queue message.
 */
async function processQueueMessage(
  msg: Message<PaymentQueueMessage | AuthOtpQueueMessage>,
  db: ReturnType<typeof getDb>,
  env: Env,
): Promise<void> {
  const payload = msg.body;
  console.log(`[Queue] Processing message type=${payload.type} id=${msg.id}`);

  switch (payload.type) {
    // ── Auth / OTP ─────────────────────────────────────────────────────────
    // TODO: When SMS providers (Twilio, etc.) are finalized, extract this block
    //       to src/modules/notifications/otp.handler.ts
    case "auth.send_otp": {
      if (payload.method === "email") {
        await sendEmail({
          to: payload.identifier,
          subject: "Your login code",
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
              <h2 style="font-size: 20px; margin-bottom: 8px;">Your login code</h2>
              <p style="color: #555; margin-bottom: 24px;">Hi ${payload.name}, enter this code to sign in:</p>
              <div style="background: #f5f5f5; border-radius: 12px; padding: 28px; text-align: center; margin-bottom: 24px;">
                <span style="font-size: 40px; font-weight: 700; letter-spacing: 10px; font-family: monospace; color: #111;">${payload.code}</span>
              </div>
              <p style="color: #888; font-size: 13px;">This code expires in 5 minutes. If you didn't request this, you can ignore this email.</p>
            </div>
          `,
          text: `Your login code is: ${payload.code}\n\nExpires in 5 minutes.`,
        });
        console.log(`[Queue] Sent OTP email to ${payload.identifier}`);
      } else if (payload.method === "phone" && payload.allowedMethod === "whatsapp_otp") {
        if (!payload.waToken || !payload.waPhoneId) {
          throw new Error("WhatsApp credentials missing in queue payload");
        }
        const waRes = await fetch(`https://graph.facebook.com/v19.0/${payload.waPhoneId}/messages`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${payload.waToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: payload.identifier.replace("+", ""),
            type: "template",
            template: {
              name: payload.waTemplate || "auth_otp",
              language: { code: "en_US" },
              components: [
                { type: "body", parameters: [{ type: "text", text: payload.code }] },
                { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: payload.code }] },
              ],
            },
          }),
        });
        if (!waRes.ok) {
          const err = await waRes.text();
          throw new Error(`WhatsApp API failed: ${err}`);
        }
        console.log(`[Queue] Sent WhatsApp OTP to ${payload.identifier}`);
      } else {
        // SMS OTP via configured BD SMS gateway
        const encryptionKey = getEncryptionKey(env as unknown as Record<string, unknown>);
        const smsProvider = await getActiveSmsProvider(db, encryptionKey);
        if (!smsProvider) {
          throw new Error("SMS OTP requested but no SMS provider is configured. Configure an SMS provider in Auth & Access settings.");
        }
        const result = await smsProvider.sendSms({
          to: payload.identifier,  // Already E.164 from customers.phone
          message: `Your login code: ${payload.code}\n\nValid for 5 minutes. Do not share.`,
        });
        if (!result.success) {
          throw new Error(`SMS OTP delivery failed via ${smsProvider.name}: ${result.rawStatus}`);
        }
        console.log(`[Queue] SMS OTP sent via ${smsProvider.name} to ${payload.identifier}, ref=${result.providerRef}`);
      }
      break;
    }

    // ── Stripe ─────────────────────────────────────────────────────────────

    case "payment.stripe.confirmed": {
      // Convert smallest currency unit → major unit using ISO 4217 decimals.
      // e.g. USD/BDT: ÷100, JPY: ÷1, BHD: ÷1000
      const stripeDecimals = getDecimalPlaces(payload.currency);
      const amountInMajor = payload.amount / Math.pow(10, stripeDecimals);
      await processPaymentConfirmed(db, {
        orderId: payload.orderId,
        paymentGateway: "stripe",
        paymentType: (payload.metadata?.paymentType as "full" | "deposit" | "balance") ?? "full",
        stripePaymentIntentId: payload.paymentIntentId,
        stripeChargeId: payload.chargeId,
        amount: amountInMajor,
        metadata: { currency: payload.currency },
      });
      console.log(`[Queue] Stripe payment confirmed for order ${payload.orderId}`);
      break;
    }

    case "payment.stripe.failed": {
      await processPaymentFailed(db, payload.orderId, "stripe", payload.paymentIntentId);
      console.log(`[Queue] Stripe payment failed for order ${payload.orderId}`);
      break;
    }

    case "payment.stripe.canceled": {
      await releaseOrderInventory(db, payload.orderId);
      console.log(`[Queue] Stripe payment cancelled, inventory released for order ${payload.orderId}`);
      break;
    }

    case "payment.stripe.refunded": {
      // Refunds are handled synchronously via the refund endpoint.
      // This message exists for audit / notification purposes.
      console.log(`[Queue] Stripe refund recorded for order ${payload.orderId}`);
      break;
    }

    // ── SSLCommerz ─────────────────────────────────────────────────────────

    case "payment.sslcommerz.confirmed": {
      await processPaymentConfirmed(db, {
        orderId: payload.orderId,
        paymentGateway: "sslcommerz",
        paymentType: (payload.paymentType as "full" | "deposit" | "balance") ?? "full",
        sslcommerzTranId: payload.tranId,
        sslcommerzValId: payload.valId,
        sslcommerzBankTranId: payload.bankTranId,
        amount: payload.amount,
        metadata: { currency: payload.currency, cardType: payload.cardType, cardBrand: payload.cardBrand },
      });
      console.log(`[Queue] SSLCommerz payment confirmed for order ${payload.orderId}`);
      break;
    }

    case "payment.sslcommerz.failed": {
      await processPaymentFailed(db, payload.orderId, "sslcommerz", payload.tranId);
      console.log(`[Queue] SSLCommerz payment failed for order ${payload.orderId}`);
      break;
    }

    // ── Polar ──────────────────────────────────────────────────────────────

    case "payment.polar.confirmed": {
      // Convert smallest currency unit → major unit using ISO 4217 decimals.
      const polarCurrency = payload.currency ?? "usd";
      const polarDecimals = getDecimalPlaces(polarCurrency);
      const amountInMajor = (payload.amount ?? 0) / Math.pow(10, polarDecimals);
      await processPaymentConfirmed(db, {
        orderId: payload.orderId,
        paymentGateway: "polar",
        paymentType: (payload.paymentType as "full" | "deposit" | "balance") ?? "full",
        polarCheckoutId: payload.checkoutId,
        amount: amountInMajor,
        metadata: { currency: payload.currency ?? "usd", ...payload.metadata },
      });
      console.log(`[Queue] Polar payment confirmed for order ${payload.orderId}`);
      break;
    }

    case "payment.polar.failed": {
      await processPaymentFailed(db, payload.orderId, "polar", payload.checkoutId);
      console.log(`[Queue] Polar payment failed for order ${payload.orderId}`);
      break;
    }

    case "payment.polar.refunded": {
      // Unlike Stripe refunds (audit-only, since refunds are admin-initiated),
      // Polar refunds can originate from the Polar dashboard or Polar's own
      // dispute auto-refund system. We must update the DB to reflect the refund.
      const result = await processPolarWebhookRefund(db, {
        orderId: payload.orderId,
        amountRefunded: payload.amountRefunded,
        totalAmount: payload.totalAmount,
        currency: payload.currency,
        polarStatus: payload.polarStatus,
      });
      if (result.success) {
        console.log(`[Queue] Polar refund processed for order ${payload.orderId} (status: ${payload.polarStatus})`);
      } else {
        throw new Error(`Polar refund failed for order ${payload.orderId}: ${result.error}`);
      }
      break;
    }

    // ── Order notifications ────────────────────────────────────────────────

    case "order.notification": {
      // Customer notifications (email, SMS, etc.)
      if (payload.customerEmail) {
        await sendOrderNotificationEmail(
          payload.customerEmail,
          payload.customerName,
          payload.orderId,
          payload.notificationType,
          payload.data,
          db,
        );
      }

      // Admin push notification — check admin channel settings before sending
      try {
        const { getAdminNotificationChannels } = await import("@scalius/core/modules/settings/settings.service");
        const adminChannels = await getAdminNotificationChannels(db);
        const enabledAdminChannels = adminChannels[payload.notificationType] || [];

        if (enabledAdminChannels.includes("push")) {
          const requestUrl = env.PUBLIC_API_BASE_URL || "https://api.scalius.com";
          await sendOrderNotification(db, {
            id: payload.orderId,
            customerName: payload.customerName,
          }, env, requestUrl);
        }
      } catch (fcmError) {
        console.error(`[Queue] Admin notification check/send failed for ${payload.orderId}:`, fcmError);
      }
      break;
    }

    default: {
      console.warn(`[Queue] Unknown message type:`, (payload as Record<string, unknown>).type);
    }
  }
}
