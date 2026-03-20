// src/server/routes/payment/stripe-routes.ts
// Hono routes for Stripe payment operations.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, sql } from "drizzle-orm";
import { orders, paymentPlans, PaymentStatus, OrderStatus } from "@scalius/database/schema";
import { createPaymentIntent } from "@scalius/core/modules/payments/stripe";
import { getStripeSettings } from "@scalius/core/modules/payments/gateway-settings";
import { getCurrencyConfig } from "@scalius/core/modules/settings/settings.service";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { NotFoundError, ValidationError, ServiceUnavailableError, ApiError } from "../../utils/api-error";
import { successEnvelope, errorResponses } from "../../schemas/responses";

import { ok } from "../../utils/api-response";
const app = new OpenAPIHono<{ Bindings: Env }>();

// ─── POST /intent ────────────────────────────────────────────────────────────

const intentSchema = z.object({
  orderId: z.string().min(1),
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
  },
});

app.openapi(createIntentRoute, async (c) => {
  const db = c.get("db");
  const stripe = await getStripeSettings(db, c.env.CACHE);

  if (!stripe) {
    throw new ServiceUnavailableError("Stripe is not configured. Please set credentials in the admin dashboard.");
  }
  if (!stripe.enabled) {
    throw new ServiceUnavailableError("Stripe gateway is disabled.");
  }

  const body = c.req.valid("json");

  // Fetch the order
  const order = await db
    .select({
      id: orders.id,
      totalAmount: orders.totalAmount,
      status: orders.status,
      paymentStatus: orders.paymentStatus,
      paidAmount: orders.paidAmount,
      balanceDue: orders.balanceDue
    })
    .from(orders)
    .where(eq(orders.id, body.orderId))
    .get();

  if (!order) throw new NotFoundError("Order not found");

  // Resolve currency from settings if not provided
  if (!body.currency) {
    const currencyConfig = await getCurrencyConfig(db, c.env.CACHE);
    body.currency = currencyConfig.code.toLowerCase();
  }

  if (order.paymentStatus === PaymentStatus.PAID) {
    throw new ValidationError("Order is already fully paid");
  }
  if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.RETURNED) {
    throw new ValidationError("Cannot pay a cancelled/returned order");
  }

  // Determine the amount to charge
  let chargeAmount: number;
  if (body.paymentType === "deposit") {
    if (!body.depositAmount) {
      throw new ValidationError("depositAmount required for deposit payment");
    }
    if (body.depositAmount >= order.totalAmount) {
      throw new ValidationError("Deposit amount must be less than order total");
    }
    chargeAmount = body.depositAmount;
  } else if (body.paymentType === "balance") {
    chargeAmount = order.balanceDue ?? (order.totalAmount - (order.paidAmount ?? 0));
    if (chargeAmount <= 0) throw new ValidationError("No balance due");
  } else {
    chargeAmount = order.totalAmount;
  }

  // Convert major-unit amount to smallest currency unit using ISO 4217 decimals.
  // e.g. USD/BDT: ×100, JPY: ×1, BHD: ×1000
  const decimals = getDecimalPlaces(body.currency);
  const amountInSmallestUnit = Math.round(chargeAmount * Math.pow(10, decimals));

  const result = await createPaymentIntent(stripe.secretKey, {
    orderId: body.orderId,
    amount: amountInSmallestUnit,
    currency: body.currency,
    paymentType: body.paymentType,
    manualCapture: body.manualCapture
  });

  if (!result.success) {
    throw new ApiError(500, "PAYMENT_ERROR", result.error || "Failed to create payment intent");
  }

  // Save PaymentIntent ID to order
  await db
    .update(orders)
    .set({ paymentIntentId: result.paymentIntentId, updatedAt: sql`unixepoch()` })
    .where(eq(orders.id, body.orderId));

  // Create payment plan record for deposit orders
  if (body.paymentType === "deposit" && body.depositAmount) {
    await db.insert(paymentPlans).values({
      id: crypto.randomUUID(),
      orderId: body.orderId,
      totalAmount: order.totalAmount,
      depositAmount: body.depositAmount,
      balanceDue: order.totalAmount - body.depositAmount,
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date()
    }).onConflictDoNothing();
  }

  return ok(c, {
    clientSecret: result.clientSecret,
    paymentIntentId: result.paymentIntentId,
    publishableKey: stripe.publishableKey,
    amount: chargeAmount,
    currency: body.currency
  });
});

export const stripePaymentRoutes = app;
