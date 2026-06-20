// src/server/routes/webhooks/sslcommerz.ts
// Webhook handler for SSLCommerz IPN (Instant Payment Notification).

import { OpenAPIHono } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { parseSSLCommerzTranId, validateSSLCommerzIPN } from "@scalius/core/modules/payments/sslcommerz";
import {
  FRESH_GATEWAY_SETTINGS_READ_OPTIONS,
  getSSLCommerzSettings,
} from "@scalius/core/modules/payments/gateway-settings";
import type { PaymentType, SSLCommerzIPNPayload, SSLCommerzValidationResult } from "@scalius/core/modules/payments/types";
import { orders, paymentPlans, PaymentMethod } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { pricesEqual, roundPrice } from "@scalius/shared/price-utils";
import type { PaymentQueueMessage } from "../../queue-consumer";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import {
  buildWebhookEventId,
  claimWebhookEvent,
  markWebhookEventFailed,
  markWebhookEventProcessed,
  markWebhookEventQueued,
} from "../../utils/webhook-idempotency";

const app = new OpenAPIHono<{ Bindings: Env }>();

const VALID_PAYMENT_TYPES = new Set<PaymentType>(["full", "deposit", "balance"]);

type ServerPaymentContext = {
  order: {
    id: string;
    totalAmount: number;
    paidAmount: number;
    balanceDue: number;
    paymentMethod: string;
  };
  plan: {
    depositAmount: number;
    balanceDue: number;
  } | null;
};

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

function parseCanonicalAmount(validation: SSLCommerzValidationResult): number | null {
  const amount = Number.parseFloat(clean(validation.amount) || clean(validation.store_amount));
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function parseCanonicalPaymentType(validation: SSLCommerzValidationResult): PaymentType | null {
  const paymentType = clean(validation.value_a);
  return VALID_PAYMENT_TYPES.has(paymentType as PaymentType) ? (paymentType as PaymentType) : null;
}

function parseCanonicalOrderId(validation: SSLCommerzValidationResult): string | null {
  const orderId = clean(validation.value_b);
  return orderId || null;
}

function amountsEqual(left: number, right: number, currency?: string): boolean {
  return pricesEqual(roundPrice(left, currency), roundPrice(right, currency));
}

async function getServerPaymentContext(db: Database, orderId: string): Promise<ServerPaymentContext | null> {
  const order = await db
    .select({
      id: orders.id,
      totalAmount: orders.totalAmount,
      paidAmount: orders.paidAmount,
      balanceDue: orders.balanceDue,
      paymentMethod: orders.paymentMethod,
    })
    .from(orders)
    .where(eq(orders.id, orderId))
    .get();

  if (!order) return null;

  const plan = await db
    .select({
      depositAmount: paymentPlans.depositAmount,
      balanceDue: paymentPlans.balanceDue,
    })
    .from(paymentPlans)
    .where(eq(paymentPlans.orderId, orderId))
    .get();

  return { order, plan: plan ?? null };
}

function resolvePaymentType(
  context: ServerPaymentContext,
  amount: number,
  currency: string,
  canonicalPaymentType: PaymentType | null,
): PaymentType | null {
  const matchingTypes = new Set<PaymentType>();

  if (amountsEqual(amount, context.order.totalAmount, currency)) {
    matchingTypes.add("full");
  }

  if (context.plan) {
    if (amountsEqual(amount, context.plan.depositAmount, currency)) {
      matchingTypes.add("deposit");
    }
    if (context.plan.balanceDue > 0 && amountsEqual(amount, context.plan.balanceDue, currency)) {
      matchingTypes.add("balance");
    }
  } else {
    const outstanding = context.order.balanceDue ?? Math.max(0, context.order.totalAmount - (context.order.paidAmount ?? 0));
    if (outstanding > 0 && context.order.paidAmount > 0 && amountsEqual(amount, outstanding, currency)) {
      matchingTypes.add("balance");
    }
  }

  if (canonicalPaymentType) {
    return matchingTypes.has(canonicalPaymentType) ? canonicalPaymentType : null;
  }

  return matchingTypes.has("deposit")
    ? "deposit"
    : matchingTypes.has("balance")
      ? "balance"
      : matchingTypes.has("full")
        ? "full"
        : null;
}

app.post("/", async (c) => {
  const db = c.get("db") as Database;
  const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
  let ssl: Awaited<ReturnType<typeof getSSLCommerzSettings>>;
  try {
    ssl = await getSSLCommerzSettings(
      db,
      c.env.CACHE,
      encryptionKey,
      FRESH_GATEWAY_SETTINGS_READ_OPTIONS,
    );
  } catch (error) {
    console.error(
      "[ssl-webhook] SSLCommerz settings read failed:",
      error instanceof Error ? error.message : error,
    );
    return c.text("RETRY", 503);
  }

  if (!ssl) {
    console.warn("[ssl-webhook] SSLCommerz not configured — ignoring IPN");
    return c.text("OK");
  }
  if (ssl.credentialErrors?.length) {
    console.error("[ssl-webhook] SSLCommerz credentials are not readable:", ssl.credentialErrors[0]);
    return c.text("RETRY", 503);
  }
  if (!ssl.storeId || !ssl.storePassword) {
    console.warn("[ssl-webhook] SSLCommerz webhook credentials are incomplete — ignoring IPN");
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

  const requestedValId = clean(payload.val_id);

  if (!requestedValId) {
    console.warn("[ssl-webhook] IPN missing val_id");
    return c.text("OK");
  }

  const validation = await validateSSLCommerzIPN(ssl.storeId, ssl.storePassword, ssl.sandbox, requestedValId);

  if (!validation) {
    console.error(`[ssl-webhook] IPN validation API call failed for val_id ${requestedValId}`);
    return c.text("RETRY", 503);
  }

  const tranId = clean(validation.tran_id);
  const valId = clean(validation.val_id);
  const parsedTran = parseSSLCommerzTranId(tranId);
  const orderId = parseCanonicalOrderId(validation) ?? parsedTran.orderId;

  if (!tranId || !valId || valId !== requestedValId) {
    console.warn("[ssl-webhook] IPN validation response missing or inconsistent canonical identifiers", {
      requestedValId,
      validationTranId: tranId,
      validationValId: valId,
    });
    return c.text("OK");
  }

  const eventId = buildWebhookEventId("sslcommerz", "ipn", `${tranId}:${valId}`);
  const claim = await claimWebhookEvent(db, {
    id: eventId,
    provider: "sslcommerz",
    eventType: "ipn",
    orderId,
    status: "processing",
    result: { orderId, tranId, valId, status: validation.status },
  });

  if (!claim.claimed) {
    return c.text("OK");
  }

  const isValid = validation.status === "VALID" || validation.status === "VALIDATED";
  const isTerminalFailure = validation.status === "FAILED" || validation.status === "CANCELLED";

  let message: PaymentQueueMessage;

  if (isValid) {
    const amount = parseCanonicalAmount(validation);
    const currency = clean(validation.currency_type) || clean(validation.currency);
    const bankTranId = clean(validation.bank_tran_id);
    const context = await getServerPaymentContext(db, orderId);

    if (!amount || !currency || !bankTranId || !context) {
      const error = !context
        ? "Canonical order not found"
        : "Validation response missing canonical payment data";
      console.warn(`[ssl-webhook] ${error} for transaction ${tranId}`);
      await markWebhookEventFailed(db, eventId, { orderId, tranId, valId, status: validation.status, error });
      return c.text("RETRY", 503);
    }

    if (context.order.paymentMethod !== PaymentMethod.SSLCOMMERZ) {
      const error = "Order is not configured for SSLCommerz payment";
      console.warn(`[ssl-webhook] ${error} for transaction ${tranId}`);
      await markWebhookEventFailed(db, eventId, { orderId, tranId, valId, status: validation.status, error });
      return c.text("RETRY", 503);
    }

    const paymentType = resolvePaymentType(
      context,
      amount,
      currency,
      parseCanonicalPaymentType(validation) ?? parsedTran.paymentType,
    );

    if (!paymentType) {
      const error = "Validated payment type or amount is inconsistent with server-side order state";
      console.warn(`[ssl-webhook] ${error} for transaction ${tranId}`);
      await markWebhookEventFailed(db, eventId, { orderId, tranId, valId, status: validation.status, error });
      return c.text("RETRY", 503);
    }

    message = {
      type: "payment.sslcommerz.confirmed",
      orderId,
      tranId,
      valId,
      bankTranId,
      amount,
      currency,
      cardType: clean(validation.card_type) || undefined,
      cardBrand: clean(validation.card_brand) || undefined,
      paymentType,
    };
  } else if (isTerminalFailure) {
    console.warn(`[ssl-webhook] IPN terminal failure for order ${tranId}: ${validation.status}`);
    message = {
      type: "payment.sslcommerz.failed",
      orderId,
      tranId,
      status: validation.status
    };
  } else {
    console.warn(`[ssl-webhook] IPN non-terminal status for order ${tranId}: ${validation.status}`);
    await markWebhookEventProcessed(db, eventId, {
      tranId,
      orderId,
      valId,
      status: validation.status,
      enqueued: false,
    });
    return c.text("OK");
  }

  const queue = c.env.PAYMENT_EVENTS_QUEUE;
  if (!queue) {
    await markWebhookEventFailed(db, eventId, { orderId, tranId, valId, error: "Queue not available" });
    return c.text("RETRY", 503);
  }

  try {
    await queue.send(message);
    await markWebhookEventQueued(db, eventId, {
      tranId,
      orderId,
      valId,
      status: validation.status,
    });
  } catch (error) {
    await markWebhookEventFailed(db, eventId, {
      tranId,
      orderId,
      valId,
      status: validation.status,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.text("RETRY", 503);
  }

  return c.text("OK");
});

export const sslcommerzWebhookRoutes = app;
