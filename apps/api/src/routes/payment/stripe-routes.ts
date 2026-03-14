// src/server/routes/payment/stripe-routes.ts
// Hono routes for Stripe payment operations.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, sql } from "drizzle-orm";
import { orders, paymentPlans, PaymentStatus, OrderStatus } from "@scalius/database/schema";
import { createPaymentIntent } from "@scalius/core/modules/payments/stripe";
import { getStripeSettings } from "@scalius/core/modules/payments/gateway-settings";
import { getCurrencyConfig } from "@scalius/core/modules/settings/settings.service";
import { NotFoundError, ValidationError } from "../../utils/api-error";

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
    200: { description: "PaymentIntent created"  },
    400: { description: "Invalid request"  },
    404: { description: "Order not found"  },
    503: { description: "Stripe not configured"  }
  }
});

app.openapi(createIntentRoute, async (c) => {
  const db = c.get("db");
  const stripe = await getStripeSettings(db, c.env.CACHE);

  if (!stripe) {
    return c.json({
      success: false,
      error: "Stripe is not configured. Please set credentials in the admin dashboard."
    }, 503);
  }
  if (!stripe.enabled) {
    return c.json({ success: false, error: "Stripe gateway is disabled." }, 503);
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
    return c.json({ success: false, error: "Order is already fully paid" }, 400);
  }
  if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.RETURNED) {
    return c.json({ success: false, error: "Cannot pay a cancelled/returned order" }, 400);
  }

  // Determine the amount to charge
  let chargeAmount: number;
  if (body.paymentType === "deposit") {
    if (!body.depositAmount) {
      return c.json({ success: false, error: "depositAmount required for deposit payment" }, 400);
    }
    if (body.depositAmount >= order.totalAmount) {
      return c.json({ success: false, error: "Deposit amount must be less than order total" }, 400);
    }
    chargeAmount = body.depositAmount;
  } else if (body.paymentType === "balance") {
    chargeAmount = order.balanceDue ?? (order.totalAmount - (order.paidAmount ?? 0));
    if (chargeAmount <= 0) return c.json({ success: false, error: "No balance due" }, 400);
  } else {
    chargeAmount = order.totalAmount;
  }

  const amountInSmallestUnit = Math.round(chargeAmount * 100);

  const result = await createPaymentIntent(stripe.secretKey, {
    orderId: body.orderId,
    amount: amountInSmallestUnit,
    currency: body.currency,
    paymentType: body.paymentType,
    manualCapture: body.manualCapture
  });

  if (!result.success) {
    return c.json({ success: false, error: result.error }, 500);
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
