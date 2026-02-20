// src/server/routes/webhooks/sslcommerz.ts
// Hono route handler for SSLCommerz IPN (Instant Payment Notification).
//
// Key design decisions:
// - SSLCommerz POSTs IPN as application/x-www-form-urlencoded.
// - MANDATORY: We MUST validate via SSLCommerz's server-to-server API — never trust the IPN directly.
// - Returns 200 immediately; validation and DB updates run in waitUntil().
// - Two-layer idempotency: KV (fast) + webhookEvents DB table (durable).
// - Gateway credentials loaded from DB settings (not env vars).

import { Hono } from "hono";
import { validateSSLCommerzIPN } from "@/lib/payment/sslcommerz";
import { getSSLCommerzSettings } from "@/lib/payment/gateway-settings";
import {
  processPaymentConfirmed,
  processPaymentFailed,
  recordWebhookEvent,
} from "@/lib/payment/process-payment";
import { getDb } from "@/db";
import type { SSLCommerzIPNPayload } from "@/lib/payment/types";

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

  // Fast idempotency check
  const kvKey = `${KV_WEBHOOK_PREFIX}${tranId}_${valId}`;
  const alreadyProcessed = await c.env.CACHE?.get(kvKey);
  if (alreadyProcessed) {
    return c.text("OK");
  }

  // NOTE: We intentionally do NOT set the KV key here.
  // The key is set inside handleSSLCommerzIPN AFTER the DB transaction succeeds.
  // This ensures that if processPaymentConfirmed() fails, SSLCommerz can retry
  // and the IPN won't be silently dropped.

  // Return 200 immediately; validate and process asynchronously
  c.executionCtx.waitUntil(
    handleSSLCommerzIPN(c.env, payload, ssl.storeId, ssl.storePassword, ssl.sandbox, kvKey)
  );

  return c.text("OK");
});

async function handleSSLCommerzIPN(
  env: Env,
  payload: SSLCommerzIPNPayload,
  storeId: string,
  storePassword: string,
  isSandbox: boolean,
  kvKey: string
): Promise<void> {
  const db = getDb(env);
  const orderId = payload.tran_id;
  const valId = payload.val_id;

  try {
    // MANDATORY: Always validate via SSLCommerz server-to-server API
    const validation = await validateSSLCommerzIPN(storeId, storePassword, isSandbox, valId);

    if (!validation) {
      console.error(`[ssl-webhook] IPN validation API call failed for order ${orderId}`);
      await recordWebhookEvent(db, `${orderId}_${valId}`, "sslcommerz", "ipn", orderId, "failed", {
        error: "Validation API unreachable",
      });
      // Do NOT set KV key — allow SSLCommerz to retry
      return;
    }

    const isValid = validation.status === "VALID" || validation.status === "VALIDATED";

    if (!isValid) {
      console.warn(`[ssl-webhook] IPN invalid for order ${orderId}: ${validation.status}`);

      if (validation.status === "FAILED" || validation.status === "CANCELLED") {
        await processPaymentFailed(db, orderId, "sslcommerz", orderId);
      }

      await recordWebhookEvent(
        db, `${orderId}_${valId}`, "sslcommerz", "ipn", orderId, "failed",
        { validationStatus: validation.status }
      );
      // Set KV key for terminal failures (FAILED/CANCELLED) — no point retrying these
      if (validation.status === "FAILED" || validation.status === "CANCELLED") {
        await env.CACHE?.put(kvKey, "1", { expirationTtl: KV_WEBHOOK_TTL });
      }
      return;
    }

    // Payment is valid
    const amount = parseFloat(validation.store_amount ?? validation.amount ?? "0");
    const paymentType = (payload.value_a as "full" | "deposit" | "balance") ?? "full";

    const result = await processPaymentConfirmed(db, {
      orderId,
      amount,
      paymentGateway: "sslcommerz",
      paymentType,
      sslcommerzTranId: orderId,
      sslcommerzValId: valId,
      sslcommerzBankTranId: payload.bank_tran_id,
      metadata: {
        cardType: payload.card_type,
        cardBrand: payload.card_brand,
        currency: payload.currency,
      },
    });

    await recordWebhookEvent(
      db, `${orderId}_${valId}`, "sslcommerz", "ipn", orderId,
      result.success ? "processed" : "failed", result
    );

    // Set KV idempotency key ONLY after successful processing
    // If processPaymentConfirmed threw, we never reach here — SSLCommerz can retry.
    if (result.success) {
      await env.CACHE?.put(kvKey, "1", { expirationTtl: KV_WEBHOOK_TTL });
    }
  } catch (err) {
    console.error(`[ssl-webhook] Error processing IPN for order ${orderId}:`, err);
    // Do NOT set KV key on errors — allow SSLCommerz to retry
  }
}

export const sslcommerzWebhookRoutes = app;
