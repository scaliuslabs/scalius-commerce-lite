// src/server/routes/webhooks/sslcommerz.ts
// Webhook handler for SSLCommerz IPN (Instant Payment Notification).

import { OpenAPIHono } from "@hono/zod-openapi";
import { validateSSLCommerzIPN } from "@scalius/core/modules/payments/sslcommerz";
import { getSSLCommerzSettings } from "@scalius/core/modules/payments/gateway-settings";
import { getDb } from "@scalius/database/client";
import type { SSLCommerzIPNPayload } from "@scalius/core/modules/payments/types";
import type { PaymentQueueMessage } from "../../queue-consumer";

const app = new OpenAPIHono<{ Bindings: Env }>();

const KV_WEBHOOK_PREFIX = "ssl_wh:";
const KV_WEBHOOK_TTL = 86400; // 24 hours

app.post("/", async (c) => {
  const db = getDb(c.env);
  const ssl = await getSSLCommerzSettings(db, c.env.CACHE);

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

  const kvKey = `${KV_WEBHOOK_PREFIX}${tranId}_${valId}`;
  const alreadyProcessed = await c.env.CACHE?.get(kvKey);
  if (alreadyProcessed) {
    return c.text("OK");
  }

  const validation = await validateSSLCommerzIPN(ssl.storeId, ssl.storePassword, ssl.sandbox, valId);

  if (!validation) {
    console.error(`[ssl-webhook] IPN validation API call failed for order ${tranId}`);
    return c.text("OK");
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
      paymentType: payload.value_a,
    };
  } else if (isTerminalFailure) {
    console.warn(`[ssl-webhook] IPN terminal failure for order ${tranId}: ${validation.status}`);
    message = {
      type: "payment.sslcommerz.failed",
      orderId: tranId,
      tranId,
      status: validation.status,
    };
  } else {
    console.warn(`[ssl-webhook] IPN non-terminal status for order ${tranId}: ${validation.status}`);
    return c.text("OK");
  }

  await c.env.PAYMENT_EVENTS_QUEUE.send(message);
  await c.env.CACHE?.put(kvKey, "queued", { expirationTtl: KV_WEBHOOK_TTL });

  return c.text("OK");
});

export const sslcommerzWebhookRoutes = app;
