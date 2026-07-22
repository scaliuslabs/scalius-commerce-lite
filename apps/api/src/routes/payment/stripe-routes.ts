// src/server/routes/payment/stripe-routes.ts
// Hono routes for Stripe payment operations.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { orders, PaymentStatus } from "@scalius/database/schema";
import { retrieveStripePaymentIntent } from "@scalius/core/modules/payments/stripe";
import {
  FRESH_GATEWAY_SETTINGS_READ_OPTIONS,
  getStripeSettings,
} from "@scalius/core/modules/payments/gateway-settings";
import type { PaymentQueueMessage } from "../../queue-consumer";
import { validateReceiptToken } from "../../utils/order-receipt-token";
import { successEnvelope, errorResponses, serviceUnavailableResponse } from "../../schemas/responses";
import { ok } from "../../utils/api-response";
import { createStripePaymentSession, isPaymentSessionProcessingResult } from "./payment-session-create";
import { acceptedPaymentSessionProcessing, paymentSessionProcessingResponse } from "./payment-session-response";
import { withPaymentProviderDeadline } from "./payment-provider-deadline";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import { NotFoundError, ServiceUnavailableError, ValidationError } from "../../utils/api-error";
import {
  buildWebhookEventId,
  claimWebhookEvent,
  markWebhookEventFailed,
  markWebhookEventQueued,
} from "../../utils/webhook-idempotency";

const app = new OpenAPIHono<{ Bindings: Env }>();
const RECEIPT_TOKEN_HEADER = "X-Receipt-Token";

// ─── POST /intent ────────────────────────────────────────────────────────────

const intentSchema = z.object({
  orderId: z.string().min(1),
  receiptToken: z.string().min(1).optional(),
  paymentType: z.enum(["full", "deposit", "balance"]).optional(),
  depositAmount: z.number().positive().optional(),
  currency: z.string().length(3).optional(),
  manualCapture: z.boolean().default(false)
});

function getReceiptToken(c: { req: { header: (name: string) => string | undefined } }, body: { receiptToken?: string }): string | undefined {
  const headerToken = c.req.header(RECEIPT_TOKEN_HEADER)?.trim();
  return body.receiptToken ?? (headerToken || undefined);
}

async function validateReceiptProof(
  c: { env: Env; req: { header: (name: string) => string | undefined } },
  db: Database,
  body: { orderId: string; receiptToken?: string },
): Promise<string> {
  const receiptToken = getReceiptToken(c, body);
  await validateReceiptToken(c.env.CACHE, body.orderId, receiptToken, db);
  if (!receiptToken) throw new Error("Receipt token validation returned without proof.");
  return receiptToken;
}

const createIntentRoute = createRoute({
  method: "post",
  path: "/intent",
  tags: ["Payments - Stripe"],
  summary: "Create a Stripe PaymentIntent for an order",
  request: {
    body: {
      content: {
        "application/json": { schema: intentSchema }
      }
    },
    headers: z.object({
      [RECEIPT_TOKEN_HEADER]: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "PaymentIntent created",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            clientSecret: z.string().optional(),
            paymentIntentId: z.string().optional(),
            publishableKey: z.string(),
            amount: z.number(),
            currency: z.string(),
          })),
        },
      },
    },
    202: paymentSessionProcessingResponse,
    ...errorResponses,
    503: serviceUnavailableResponse,
  },
});

app.openapi(createIntentRoute, async (c) => {
  const db = c.get("db");
  const body = c.req.valid("json");
  const receiptToken = await validateReceiptProof(c, db, body);

  const result = await createStripePaymentSession(c, {
    orderId: body.orderId,
    paymentType: body.paymentType,
    depositAmount: body.depositAmount,
    proof: { kind: "receipt", receiptToken },
    returnTarget: { kind: "receipt" },
  });

  if (isPaymentSessionProcessingResult(result)) {
    return acceptedPaymentSessionProcessing(c, result);
  }

  return ok(c, result.stripe);
});

// ─── POST /reconcile ────────────────────────────────────────────────────────

const reconcileSchema = z.object({
  orderId: z.string().min(1),
  receiptToken: z.string().min(1).optional(),
});

const reconcileResultSchema = z.object({
  status: z.enum(["pending", "scheduled", "settled"]),
  providerStatus: z.string().nullable(),
});

const reconcileRoute = createRoute({
  method: "post",
  path: "/reconcile",
  tags: ["Payments - Stripe"],
  summary: "Verify and reconcile a Stripe payment for a private order receipt",
  request: {
    body: {
      content: {
        "application/json": { schema: reconcileSchema },
      },
    },
    headers: z.object({
      [RECEIPT_TOKEN_HEADER]: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Payment is pending or already settled",
      content: { "application/json": { schema: successEnvelope(reconcileResultSchema) } },
    },
    202: {
      description: "Confirmed provider payment was scheduled for settlement",
      content: { "application/json": { schema: successEnvelope(reconcileResultSchema) } },
    },
    ...errorResponses,
    503: serviceUnavailableResponse,
  },
});

app.openapi(reconcileRoute, async (c) => {
  const db = c.get("db");
  const body = c.req.valid("json");
  await validateReceiptProof(c, db, body);

  const order = await db
    .select({
      id: orders.id,
      paymentMethod: orders.paymentMethod,
      paymentStatus: orders.paymentStatus,
      paymentIntentId: orders.paymentIntentId,
    })
    .from(orders)
    .where(eq(orders.id, body.orderId))
    .get();

  if (!order) throw new NotFoundError("Order not found");
  if (order.paymentMethod !== "stripe" || !order.paymentIntentId) {
    throw new ValidationError("This order does not have a Stripe payment to verify.");
  }
  if (order.paymentStatus === PaymentStatus.PAID) {
    return ok(c, { status: "settled" as const, providerStatus: "succeeded" });
  }

  const settings = await getStripeSettings(
    db,
    c.env.CACHE,
    getCredentialEncryptionKey(c.env as Record<string, unknown>),
    FRESH_GATEWAY_SETTINGS_READ_OPTIONS,
  );
  if (!settings?.enabled || !settings.secretKey || settings.credentialErrors?.length) {
    throw new ServiceUnavailableError("Stripe payment verification is temporarily unavailable.");
  }

  const providerResult = await withPaymentProviderDeadline(
    "Stripe",
    (_signal, requestTimeoutMs) => retrieveStripePaymentIntent(
      settings.secretKey,
      order.paymentIntentId!,
      requestTimeoutMs,
    ),
  );
  const paymentIntent = providerResult.paymentIntent;
  if (!providerResult.success || !paymentIntent) {
    throw new ServiceUnavailableError("Stripe payment verification is temporarily unavailable.");
  }
  if (
    paymentIntent.id !== order.paymentIntentId ||
    paymentIntent.metadata.orderId !== order.id
  ) {
    throw new ValidationError("Stripe payment verification did not match this order.");
  }
  if (paymentIntent.status !== "succeeded") {
    return ok(c, {
      status: "pending" as const,
      providerStatus: paymentIntent.status,
    });
  }

  const eventId = buildWebhookEventId(
    "stripe",
    "payment_intent.succeeded",
    `buyer-reconcile:${paymentIntent.id}`,
  );
  const claim = await claimWebhookEvent(db, {
    id: eventId,
    provider: "stripe",
    eventType: "payment_intent.succeeded",
    orderId: order.id,
    status: "processing",
    result: { source: "buyer_receipt_reconciliation" },
  });

  if (!claim.claimed) {
    const settled = claim.existing?.status === "processed";
    return ok(c, {
      status: settled ? "settled" as const : "scheduled" as const,
      providerStatus: paymentIntent.status,
    });
  }

  const queue = c.env.PAYMENT_EVENTS_QUEUE;
  if (!queue) {
    await markWebhookEventFailed(db, eventId, { error: "Queue not available" });
    throw new ServiceUnavailableError("Stripe payment verification is temporarily unavailable.");
  }

  const message: PaymentQueueMessage = {
    type: "payment.stripe.confirmed",
    orderId: order.id,
    paymentIntentId: paymentIntent.id,
    amount: paymentIntent.amountReceived,
    currency: paymentIntent.currency,
    ...(paymentIntent.chargeId ? { chargeId: paymentIntent.chargeId } : {}),
    metadata: paymentIntent.metadata,
    webhookEventId: eventId,
  };

  try {
    await queue.send(message);
    await markWebhookEventQueued(db, eventId, {
      source: "buyer_receipt_reconciliation",
      providerStatus: paymentIntent.status,
    });
  } catch (error) {
    await markWebhookEventFailed(db, eventId, {
      source: "buyer_receipt_reconciliation",
      error: error instanceof Error ? error.message : String(error),
    });
    throw new ServiceUnavailableError("Stripe payment verification is temporarily unavailable.");
  }

  return c.json({
    success: true as const,
    data: { status: "scheduled" as const, providerStatus: paymentIntent.status },
  }, 202);
});

export const stripePaymentRoutes = app;
