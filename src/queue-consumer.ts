// src/queue-consumer.ts
// Cloudflare Queue consumer for async payment processing and order notifications.
// This handler is invoked by Cloudflare when messages are dequeued from
// the payment-events and order-notifications queues.
//
// Architecture:
//   Webhook handler  →  enqueue message  →  return 200 immediately
//   Queue consumer   →  process message  →  update DB, send notifications
//
// This makes webhooks resilient: Cloudflare retries failed queue messages
// automatically (up to max_retries = 3).

import { getDb } from "@/db";
import { processPaymentConfirmed, processPaymentFailed, releaseOrderInventory } from "@/modules/payments/process-payment";
import { sendEmail } from "@/integrations/email";
import { nanoid } from "nanoid";
import { sql, eq } from "drizzle-orm";
import { orders, orderItems, customers, customerHistory, discountUsage } from "@/db/schema";
import { reserveMultiple, releaseMultiple } from "@/modules/inventory";
import { initCODTracking } from "@/modules/payments/cod";

// ── Message types ──────────────────────────────────────────────────────────

export type PaymentQueueMessage =
  | {
    type: "payment.stripe.confirmed";
    orderId: string;
    paymentIntentId: string;
    amount: number; // in cents
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
    amountRefunded: number; // in cents
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
    amount?: number; // in cents
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
    type: "order.notification";
    orderId: string;
    customerEmail?: string;
    customerName: string;
    notificationType: "order_created" | "order_confirmed" | "order_shipped" | "order_delivered";
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

export type OrderIngestQueueMessage = {
  type: "order.ingest";
  checkoutToken: string;
  existingCustomer: { id: string } | null;
  orderData: any;
  items: any[];
  discountUsage: { discountId: string; amountDiscounted: number } | null;
  requestUrl: string;
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

  // If this batch contains order ingest routing, handle it completely differently
  // Since we want to perform a SINGLE db.batch() across multiple queue messages
  if (batch.queue === "order-ingest-queue" || batch.messages.some(m => m.body.type === "order.ingest")) {
    await handleOrderIngestBatch(batch as unknown as MessageBatch<OrderIngestQueueMessage>, db, env);
    return;
  }

  // Process each message independently
  const results = await Promise.allSettled(
    batch.messages.map((msg) => processQueueMessage(msg as unknown as Message<PaymentQueueMessage | AuthOtpQueueMessage>, db))
  );

  // Ack successful messages, retry failed ones
  for (let i = 0; i < batch.messages.length; i++) {
    const result = results[i];
    const msg = batch.messages[i];
    if (result.status === "fulfilled") {
      msg.ack();
    } else {
      console.error(`[Queue] Failed to process message ${msg.id}:`, result.reason);
      msg.retry({ delaySeconds: 30 }); // Retry after 30s
    }
  }
}

/**
 * Handle a batch of order ingest messages.
 * This aggregates all orders in the batch and performs a single db.batch()
 */
async function handleOrderIngestBatch(
  batch: MessageBatch<OrderIngestQueueMessage>,
  db: ReturnType<typeof getDb>,
  env: Env
): Promise<void> {
  if (batch.messages.length === 0) return;
  console.log(`[Queue] Processing ORDER_INGEST_QUEUE batch of ${batch.messages.length} messages`);

  const writeBatch: any[] = [];
  const reservationEntries: { variantId: string; quantity: number; pool: "regular" | "preorder" | "backorder" }[] = [];
  const orderIdsForReservation: string[] = [];

  // Arrays to keep track of message status
  const successMessages: Message<OrderIngestQueueMessage>[] = [];
  const failedMessages: { msg: Message<OrderIngestQueueMessage>; reason: string }[] = [];

  for (const msg of batch.messages) {
    const payload = msg.body;
    try {
      let customerId = payload.existingCustomer?.id;

      // Accumulate reservation entries
      const orderReservationEntries = payload.items
        .filter((item: any) => item.variantId !== null)
        .map((item: any) => ({
          variantId: item.variantId as string,
          quantity: item.quantity,
          pool: payload.orderData.inventoryPool as "regular" | "preorder" | "backorder",
        }));

      if (orderReservationEntries.length > 0) {
        reservationEntries.push(...orderReservationEntries);
        // We use the first order ID for the reservation log, or pass null
        orderIdsForReservation.push(payload.orderData.id);
      }

      // Customer
      if (!customerId) {
        customerId = "cust_" + nanoid();
        writeBatch.push(
          db.insert(customers).values({
            id: customerId,
            name: payload.orderData.customerName,
            phone: payload.orderData.customerPhone,
            email: payload.orderData.customerEmail,
            address: payload.orderData.shippingAddress,
            city: payload.orderData.city,
            zone: payload.orderData.zone,
            area: payload.orderData.area,
            cityName: payload.orderData.cityName,
            zoneName: payload.orderData.zoneName,
            areaName: payload.orderData.areaName,
            totalOrders: 1,
            totalSpent: payload.orderData.totalAmount,
            lastOrderAt: sql`unixepoch()`,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
          })
        );
        writeBatch.push(
          db.insert(customerHistory).values({
            id: "hist_" + nanoid(),
            customerId: customerId,
            name: payload.orderData.customerName,
            email: payload.orderData.customerEmail,
            phone: payload.orderData.customerPhone,
            address: payload.orderData.shippingAddress,
            city: payload.orderData.city,
            zone: payload.orderData.zone,
            area: payload.orderData.area,
            cityName: payload.orderData.cityName,
            zoneName: payload.orderData.zoneName,
            areaName: payload.orderData.areaName,
            changeType: "created",
            createdAt: sql`unixepoch()`,
          })
        );
      } else {
        writeBatch.push(
          db.update(customers).set({
            totalOrders: sql`${customers.totalOrders} + 1`,
            totalSpent: sql`${customers.totalSpent} + ${payload.orderData.totalAmount}`,
            lastOrderAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
          }).where(eq(customers.id, customerId))
        );
      }

      // Order
      writeBatch.push(db.insert(orders).values({
        ...payload.orderData,
        customerId,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
      }));

      // Items
      if (payload.items.length > 0) {
        writeBatch.push(
          db.insert(orderItems).values(
            payload.items.map((item: any) => ({
              id: "item_" + nanoid(),
              orderId: payload.orderData.id,
              productId: item.productId,
              variantId: item.variantId,
              quantity: item.quantity,
              price: item.price,
              productName: item.productName,
              variantLabel: item.variantLabel,
              fulfillmentStatus: "pending" as const,
              createdAt: sql`unixepoch()`,
            }))
          )
        );
      }

      // Discount
      if (payload.discountUsage) {
        writeBatch.push(
          db.insert(discountUsage).values({
            id: "du_" + nanoid(),
            discountId: payload.discountUsage.discountId,
            orderId: payload.orderData.id,
            customerId: customerId,
            amountDiscounted: payload.discountUsage.amountDiscounted,
            createdAt: sql`unixepoch()`,
          })
        );
      }

      successMessages.push(msg);

    } catch (e) {
      console.error(`[Queue] Error preparing order ${payload.orderData.id}:`, e);
      failedMessages.push({ msg, reason: String(e) });
    }
  }

  console.log(`[Queue] Prepped ${writeBatch.length} statements for ${successMessages.length} successful orders`);

  // 1. Run Reservations for the entire batch
  if (reservationEntries.length > 0) {
    console.log(`[Queue] Running reserveMultiple for ${reservationEntries.length} entries`);
    const reserveResult = await reserveMultiple(db, reservationEntries, orderIdsForReservation[0] || "batch");
    if (!reserveResult.success) {
      console.error("[Queue] Batched reservation failed:", reserveResult.results);
      // Hard fail the entire batch to retry
      for (const msg of batch.messages) {
        await setCheckoutStatus(env, msg.body.checkoutToken, "failed", "Insufficient stock preventing batch ingestion.");
        msg.retry({ delaySeconds: 15 });
      }
      return;
    }
    console.log(`[Queue] reserveMultiple completed successfully`);
  }

  // 2. Execute DB Batch Write
  try {
    console.log(`[Queue] Calling db.batch() with ${writeBatch.length} queries`);
    if (writeBatch.length > 0) {
      await db.batch(writeBatch as any);
    }
    console.log(`[Queue] db.batch() completed successfully`);

    // 3. Mark success
    for (const msg of successMessages) {
      const payload = msg.body;

      // Initialize COD tracking if necessary
      if (payload.orderData.paymentMethod === "cod") {
        await initCODTracking(db, { orderId: payload.orderData.id }).catch((err) =>
          console.error("[Queue] COD tracking init failed for order", payload.orderData.id, err)
        );
      }

      await setCheckoutStatus(env, payload.checkoutToken, "completed");
      msg.ack();
      console.log(`[Queue] Acked order ${payload.orderData.id}`);
    }

    // Handle individual prep failures
    for (const failed of failedMessages) {
      console.log(`[Queue] Failing individual prep for ${failed.msg.body.checkoutToken}`);
      await setCheckoutStatus(env, failed.msg.body.checkoutToken, "failed", failed.reason);
      failed.msg.retry({ delaySeconds: 30 });
    }

    console.log(`[Queue] Batch processing completely finished`);

  } catch (batchError) {
    console.error("[Queue] Order ingest DB batch failed WITH EXCEPTION:", batchError);
    // 4. Rollback
    if (reservationEntries.length > 0) {
      console.log(`[Queue] Rolling back inventory...`);
      await releaseMultiple(db, reservationEntries, orderIdsForReservation[0] || "batch").catch(releaseErr =>
        console.error("[Queue] Rollback release failed:", releaseErr)
      );
    }

    // Retry everything
    for (const msg of batch.messages) {
      await setCheckoutStatus(env, msg.body.checkoutToken, "failed", "Database write error during heavy traffic. Retrying.");
      msg.retry({ delaySeconds: 15 });
    }
  }
}

async function setCheckoutStatus(env: Env, token: string, status: "processing" | "completed" | "failed", error?: string) {
  if (!env.CACHE) {
    console.warn(`[Queue] CACHE not bound when trying to set status to ${status}`);
    return;
  }
  const kvKey = `checkout_status:${token}`;
  console.log(`[Queue] Writing ${status} to KV ${kvKey}`);

  try {
    // Get existing to preserve orderId
    const existingStr = await env.CACHE.get(kvKey);
    const existing = existingStr ? JSON.parse(existingStr) : {};

    await env.CACHE.put(
      kvKey,
      JSON.stringify({ ...existing, status, error, updatedAt: Date.now() }),
      { expirationTtl: 86400 } // Keep final status for 24h
    );
    console.log(`[Queue] Successfully wrote ${status} to KV`);
  } catch (kvErr) {
    console.error(`[Queue] Failed to write KV status ${status}:`, kvErr);
  }
}

/**
 * Process a single queue message.
 */
async function processQueueMessage(
  msg: Message<PaymentQueueMessage | AuthOtpQueueMessage>,
  db: ReturnType<typeof getDb>,
): Promise<void> {
  const payload = msg.body;
  console.log(`[Queue] Processing message type=${payload.type} id=${msg.id}`);

  switch (payload.type) {
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
            "Content-Type": "application/json"
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
                { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: payload.code }] }
              ]
            }
          })
        });
        if (!waRes.ok) {
          const err = await waRes.text();
          throw new Error(`WhatsApp API failed: ${err}`);
        }
        console.log(`[Queue] Sent WhatsApp OTP to ${payload.identifier}`);
      } else {
        console.log(`[Queue] SMS OTP requested to ${payload.identifier}. Provider logic pending.`);
      }
      break;
    }
    case "payment.stripe.confirmed": {
      const amountInMajor = payload.amount / 100; // Convert cents to major currency unit
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
      await processPaymentFailed(db, payload.orderId, "stripe");
      console.log(`[Queue] Stripe payment failed for order ${payload.orderId}`);
      break;
    }

    case "payment.stripe.canceled": {
      await releaseOrderInventory(db, payload.orderId);
      console.log(`[Queue] Stripe payment cancelled, inventory released for order ${payload.orderId}`);
      break;
    }

    case "payment.stripe.refunded": {
      // Refunds handled synchronously via the refund endpoint
      // Queue message is for audit/notification purposes
      console.log(`[Queue] Stripe refund recorded for order ${payload.orderId}`);
      break;
    }

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
      await processPaymentFailed(db, payload.orderId, "sslcommerz");
      console.log(`[Queue] SSLCommerz payment failed for order ${payload.orderId}`);
      break;
    }

    case "payment.polar.confirmed": {
      const amountInMajor = (payload.amount ?? 0) / 100; // Convert cents to major currency unit
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
      await processPaymentFailed(db, payload.orderId, "polar");
      console.log(`[Queue] Polar payment failed for order ${payload.orderId}`);
      break;
    }

    case "order.notification": {
      if (payload.customerEmail) {
        await sendOrderNotificationEmail(
          payload.customerEmail,
          payload.customerName,
          payload.orderId,
          payload.notificationType,
          payload.data,
        );
      }
      break;
    }

    default: {
      console.warn(`[Queue] Unknown message type:`, (payload as any).type);
    }
  }
}

// ── Email notification helper ──────────────────────────────────────────────

async function sendOrderNotificationEmail(
  email: string,
  name: string,
  orderId: string,
  type: "order_created" | "order_confirmed" | "order_shipped" | "order_delivered",
  data?: Record<string, unknown>,
): Promise<void> {
  const subjects: Record<string, string> = {
    order_created: `Order #${orderId} Received`,
    order_confirmed: `Order #${orderId} Confirmed`,
    order_shipped: `Order #${orderId} Shipped`,
    order_delivered: `Order #${orderId} Delivered`,
  };

  const messages: Record<string, string> = {
    order_created: `Thank you for your order, ${name}! We've received your order <strong>#${orderId}</strong> and will process it shortly.`,
    order_confirmed: `Great news, ${name}! Your order <strong>#${orderId}</strong> has been confirmed and is being prepared.`,
    order_shipped: `Your order <strong>#${orderId}</strong> is on its way, ${name}! ${data?.trackingId ? `Tracking ID: <strong>${data.trackingId}</strong>` : ""}`,
    order_delivered: `Your order <strong>#${orderId}</strong> has been delivered, ${name}! We hope you love your purchase.`,
  };

  await sendEmail({
    to: email,
    subject: subjects[type] || `Order #${orderId} Update`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>${subjects[type] || "Order Update"}</h2>
        <p>${messages[type] || `Your order #${orderId} has been updated.`}</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
        <p style="color: #999; font-size: 12px;">
          This is an automated email regarding your order from our store.
        </p>
      </div>
    `,
    text: `${name}, ${messages[type]?.replace(/<[^>]+>/g, "") || `Order #${orderId} updated.`}`,
  });
}
