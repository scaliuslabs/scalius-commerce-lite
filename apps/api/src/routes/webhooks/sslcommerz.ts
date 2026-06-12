// src/server/routes/webhooks/sslcommerz.ts
// Webhook handler for SSLCommerz IPN (Instant Payment Notification).

import { OpenAPIHono } from "@hono/zod-openapi";
import { validateSSLCommerzIPN } from "@scalius/core/modules/payments/sslcommerz";
import { getSSLCommerzSettings } from "@scalius/core/modules/payments/gateway-settings";
import type { SSLCommerzIPNPayload } from "@scalius/core/modules/payments/types";
import type { PaymentQueueMessage } from "../../queue-consumer";
import { getEncryptionKey } from "../../utils/encryption-key";
import {
  buildWebhookEventId,
  claimWebhookEvent,
  markWebhookEventFailed,
  markWebhookEventProcessed,
  markWebhookEventQueued,
} from "../../utils/webhook-idempotency";

const app = new OpenAPIHono<{ Bindings: Env }>();

app.post("/", async (c) => {
  const db = c.get("db");
  const encryptionKey = getEncryptionKey(c.env as Record<string, unknown>);
  const ssl = await getSSLCommerzSettings(db, c.env.CACHE, encryptionKey);

  if (!ssl) {
    console.warn("[ssl-webhook] SSLCommerz not configured — ignoring IPN");
    return c.text("OK");
  }

  // Parse form-encoded IPN payload
  let payload: SSLCommerzIPNPayload;
  try {
    const formText = await c.req.text();
    const params = new URLSearchParams(formText);
    payload = Object.fromEntries(params.entries()) as SSLCommerzIPNPayload;
  } catch {
    return c.text("OK");
  }

  const tranId = payload.tran_id;
  const valId = payload.val_id;

  if (!tranId || !valId) {
    console.warn("[ssl-webhook] IPN missing tran_id or val_id");
    return c.text("OK");
  }

  const eventId = buildWebhookEventId("sslcommerz", "ipn", `${tranId}:${valId}`);
  const claim = await claimWebhookEvent(db, {
    id: eventId,
    provider: "sslcommerz",
    eventType: "ipn",
    orderId: tranId,
    status: "processing",
    result: { tranId, valId },
  });

  if (!claim.claimed) {
    return c.text("OK");
  }

  const validation = await validateSSLCommerzIPN(ssl.storeId, ssl.storePassword, ssl.sandbox, valId);

  if (!validation) {
    console.error(`[ssl-webhook] IPN validation API call failed for order ${tranId}`);
    await markWebhookEventFailed(db, eventId, { tranId, valId, error: "Validation API call failed" });
    return c.text("RETRY", 503);
  }

  const isValid = validation.status === "VALID" || validation.status === "VALIDATED";
  const isTerminalFailure = validation.status === "FAILED" || validation.status === "CANCELLED";

  let message: PaymentQueueMessage | null = null;

  if (isValid) {
    const amount = parseFloat(validation.amount ?? validation.store_amount ?? "0");

    message = {
      type: "payment.sslcommerz.confirmed",
      orderId: tranId,
      tranId,
      valId,
      bankTranId: payload.bank_tran_id,
      amount,
      currency: payload.currency,
      cardType: payload.card_type,
      cardBrand: payload.card_brand,
      paymentType: payload.value_a
    };
  } else if (isTerminalFailure) {
    console.warn(`[ssl-webhook] IPN terminal failure for order ${tranId}: ${validation.status}`);
    message = {
      type: "payment.sslcommerz.failed",
      orderId: tranId,
      tranId,
      status: validation.status
    };
  } else {
    console.warn(`[ssl-webhook] IPN non-terminal status for order ${tranId}: ${validation.status}`);
    await markWebhookEventProcessed(db, eventId, {
      tranId,
      valId,
      status: validation.status,
      enqueued: false,
    });
    return c.text("OK");
  }

  const queue = c.env.PAYMENT_EVENTS_QUEUE;
  if (!queue) {
    await markWebhookEventFailed(db, eventId, { tranId, valId, error: "Queue not available" });
    return c.text("RETRY", 503);
  }

  try {
    await queue.send(message);
    await markWebhookEventQueued(db, eventId, {
      tranId,
      valId,
      status: validation.status,
    });
  } catch (error) {
    await markWebhookEventFailed(db, eventId, {
      tranId,
      valId,
      status: validation.status,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.text("RETRY", 503);
  }

  return c.text("OK");
});

export const sslcommerzWebhookRoutes = app;
