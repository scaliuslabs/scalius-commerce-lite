// src/server/routes/payment/stripe-routes.ts
// Hono routes for Stripe payment operations.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, sql } from "drizzle-orm";
import { orders, paymentPlans, PaymentMethod } from "@scalius/database/schema";
import { createPaymentIntent } from "@scalius/core/modules/payments/stripe";
import {
  buildPaymentSessionAttemptIdentity,
  claimPaymentSessionAttempt,
  markPaymentSessionAttemptCreated,
  markPaymentSessionAttemptFailed,
} from "@scalius/core/modules/payments/payment-session-attempts";
import {
  FRESH_GATEWAY_SETTINGS_READ_OPTIONS,
  getStripeSettings,
} from "@scalius/core/modules/payments/gateway-settings";
import { assertNoActiveShipmentClaim } from "@scalius/core/modules/orders/shipment-claim";
import { getCurrencyConfig } from "@scalius/core/modules/settings/settings.service";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { NotFoundError, ValidationError, ServiceUnavailableError, ApiError } from "../../utils/api-error";
import { getEncryptionKey } from "../../utils/encryption-key";
import { validateReceiptToken } from "../../utils/order-receipt-token";
import { successEnvelope, errorResponses, serviceUnavailableResponse } from "../../schemas/responses";
import { assertPaymentSessionOrderPayable, resolvePaymentSessionPolicy } from "./payment-session-policy";
import { assertGatewayEnabledForCheckout } from "./payment-method-allowlist";

import { ok } from "../../utils/api-response";
const app = new OpenAPIHono<{ Bindings: Env }>();

type StripeIntentResponse = {
  clientSecret?: string;
  paymentIntentId?: string;
  publishableKey: string;
  amount: number;
  currency: string;
};

// ─── POST /intent ────────────────────────────────────────────────────────────

const intentSchema = z.object({
  orderId: z.string().min(1),
  receiptToken: z.string().min(1),
  paymentType: z.enum(["full", "deposit", "balance"]).default("full"),
  depositAmount: z.number().positive().optional(),
  currency: z.string().length(3).optional(),
  manualCapture: z.boolean().default(false)
});

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
    }
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
    ...errorResponses,
    503: serviceUnavailableResponse,
  },
});

app.openapi(createIntentRoute, async (c) => {
  const db = c.get("db");
  const body = c.req.valid("json");
  await validateReceiptToken(c.env.CACHE, body.orderId, body.receiptToken, db);

  // Fetch the order
  const order = await db
    .select({
      id: orders.id,
      totalAmount: orders.totalAmount,
      status: orders.status,
      paymentMethod: orders.paymentMethod,
      paymentStatus: orders.paymentStatus,
      paidAmount: orders.paidAmount,
      balanceDue: orders.balanceDue,
      deletedAt: orders.deletedAt,
      shipmentClaimId: orders.shipmentClaimId,
      shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt
    })
    .from(orders)
    .where(eq(orders.id, body.orderId))
    .get();

  if (!order) throw new NotFoundError("Order not found");
  assertNoActiveShipmentClaim(order);
  assertPaymentSessionOrderPayable(order);
  if (order.paymentMethod !== PaymentMethod.STRIPE) {
    throw new ValidationError("Order is not configured for Stripe payment");
  }

  const encryptionKey = getEncryptionKey(c.env as Record<string, unknown>);
  const checkoutFlowSettings = await assertGatewayEnabledForCheckout(db, c.env.CACHE, encryptionKey, "stripe");
  const policy = await resolvePaymentSessionPolicy(db, order, {
    paymentType: body.paymentType,
    depositAmount: body.depositAmount,
  }, checkoutFlowSettings);

  const currencyConfig = await getCurrencyConfig(db, c.env.CACHE);
  const currency = currencyConfig.code.toLowerCase();
  const stripe = await getStripeSettings(
    db,
    c.env.CACHE,
    encryptionKey,
    FRESH_GATEWAY_SETTINGS_READ_OPTIONS,
  );

  if (!stripe) {
    throw new ServiceUnavailableError("Stripe is not configured. Please set credentials in the admin dashboard.");
  }
  if (!stripe.enabled) {
    throw new ServiceUnavailableError("Stripe gateway is disabled.");
  }

  // Convert major-unit amount to smallest currency unit using ISO 4217 decimals.
  // e.g. USD/BDT: ×100, JPY: ×1, BHD: ×1000
  const decimals = getDecimalPlaces(currency);
  const amountInSmallestUnit = Math.round(policy.chargeAmount * Math.pow(10, decimals));

  const attemptIdentity = await buildPaymentSessionAttemptIdentity({
    orderId: body.orderId,
    gateway: "stripe",
    paymentType: policy.paymentType,
    amount: policy.chargeAmount,
    currency,
    receiptToken: body.receiptToken,
    requestContext: {
      amountInSmallestUnit,
      manualCapture: false,
    },
  });
  const attemptClaim = await claimPaymentSessionAttempt<StripeIntentResponse>(db, attemptIdentity);
  if (attemptClaim.status === "replay") {
    return ok(c, attemptClaim.response);
  }

  let result: Awaited<ReturnType<typeof createPaymentIntent>>;
  try {
    result = await createPaymentIntent(stripe.secretKey, {
      orderId: body.orderId,
      amount: amountInSmallestUnit,
      currency,
      paymentType: policy.paymentType,
      manualCapture: false,
      idempotencyKey: attemptIdentity.attemptKey,
    });
  } catch (error: unknown) {
    await markPaymentSessionAttemptFailed(db, attemptClaim.attempt, error)
      .catch((markError: unknown) => console.error("[payments] Failed to mark Stripe session attempt failed:", markError));
    throw error;
  }

  if (!result.success) {
    await markPaymentSessionAttemptFailed(db, attemptClaim.attempt, result.error || "Failed to create payment intent")
      .catch((error: unknown) => console.error("[payments] Failed to mark Stripe session attempt failed:", error));
    throw new ApiError(500, "PAYMENT_ERROR", result.error || "Failed to create payment intent");
  }

  const responsePayload: StripeIntentResponse = {
    clientSecret: result.clientSecret,
    paymentIntentId: result.paymentIntentId,
    publishableKey: stripe.publishableKey,
    amount: policy.chargeAmount,
    currency
  };

  await markPaymentSessionAttemptCreated(db, attemptClaim.attempt, {
    providerSessionId: result.paymentIntentId,
    response: responsePayload,
  });

  // Save PaymentIntent ID to order
  try {
    await db
      .update(orders)
      .set({ paymentIntentId: result.paymentIntentId, updatedAt: sql`unixepoch()` })
      .where(eq(orders.id, body.orderId));

    // Create payment plan record for deposit orders
    if (policy.paymentType === "deposit") {
      await db.insert(paymentPlans).values({
        id: crypto.randomUUID(),
        orderId: body.orderId,
        totalAmount: order.totalAmount,
        depositAmount: policy.depositAmount,
        balanceDue: policy.balanceDue,
        status: "pending",
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`
      }).onConflictDoNothing();
    }
  } catch (error: unknown) {
    console.error("[payments] Stripe session was created, but local order session side effects failed:", error);
  }

  return ok(c, responsePayload);
});

export const stripePaymentRoutes = app;
