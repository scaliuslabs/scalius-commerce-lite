// src/server/routes/webhooks/sslcommerz.ts
// Hono route handler for SSLCommerz IPN (Instant Payment Notification).
//
// Key design decisions:
// - SSLCommerz POSTs IPN as application/x-www-form-urlencoded.
// - MANDATORY: We MUST validate via SSLCommerz's server-to-server API — never trust the IPN directly.
//   Validation happens synchronously before enqueuing (it is the auth layer for SSLCommerz).
// - Enqueues to PAYMENT_EVENTS_QUEUE after successful server-side validation.
//   Cloudflare Queue consumer handles all DB writes and retries automatically.
// - Returns 200 immediately after enqueuing; SSLCommerz never sees processing latency.
// - Two-layer idempotency: KV fast check → set AFTER enqueuing succeeds.
// - FAILED/CANCELLED IPNs enqueue a failure message so the queue consumer can mark the order.
// - Gateway credentials loaded from DB settings (not env vars).

import { Hono } from "hono";
import { validateSSLCommerzIPN } from "@/lib/payment/sslcommerz";
import { getSSLCommerzSettings } from "@/lib/payment/gateway-settings";
import { getDb } from "@/db";
import type { SSLCommerzIPNPayload } from "@/lib/payment/types";
import type { PaymentQueueMessage } from "@/queue-consumer";

const app = new Hono<{ Bindings: Env }>();

const KV_WEBHOOK_PREFIX = "ssl_wh:";
const KV_WEBHOOK_TTL = 86400; // 24 hours

app.post("/", async (c) => {
  const db = getDb(c.env);
  const ssl = await getSSLCommerzSettings(db, c.env.CACHE);

  if (!ssl) {
    // Always 200 to SSLCommerz to prevent retries for unconfigured gateway
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

  // Fast idempotency check — prevents duplicate queue messages for the same IPN
  const kvKey = `${KV_WEBHOOK_PREFIX}${tranId}_${valId}`;
  const alreadyProcessed = await c.env.CACHE?.get(kvKey);
  if (alreadyProcessed) {
    return c.text("OK");
  }

  // MANDATORY: Validate via SSLCommerz server-to-server API — this is the auth layer.
  // We do this synchronously so we never enqueue unvalidated IPNs.
  const validation = await validateSSLCommerzIPN(ssl.storeId, ssl.storePassword, ssl.sandbox, valId);

  if (!validation) {
    // Validation API unreachable — do NOT set KV key so SSLCommerz can retry
    console.error(`[ssl-webhook] IPN validation API call failed for order ${tranId}`);
    return c.text("OK");
  }

  const isValid = validation.status === "VALID" || validation.status === "VALIDATED";
  const isTerminalFailure = validation.status === "FAILED" || validation.status === "CANCELLED";

  let message: PaymentQueueMessage | null = null;

  if (isValid) {
    const amount = parseFloat(validation.store_amount ?? validation.amount ?? "0");

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
    // Non-terminal status (e.g. PENDING, UNATTEMPTED) — do not set KV key, allow retry
    console.warn(`[ssl-webhook] IPN non-terminal status for order ${tranId}: ${validation.status}`);
    return c.text("OK");
  }

  await c.env.PAYMENT_EVENTS_QUEUE.send(message);
  // Set KV idempotency key AFTER enqueuing succeeds — prevents double-enqueue on retries
  await c.env.CACHE?.put(kvKey, "queued", { expirationTtl: KV_WEBHOOK_TTL });

  return c.text("OK");
});

export const sslcommerzWebhookRoutes = app;
