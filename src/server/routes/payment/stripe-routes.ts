// src/server/routes/payment/stripe-routes.ts
// Hono routes for Stripe payment operations.
// Credentials are loaded from the DB settings table (set via admin dashboard).
//
// POST /payment/stripe/intent       - Create PaymentIntent (storefront)
// POST /payment/stripe/capture/:id  - Capture manual PI (admin)
// POST /payment/stripe/cancel/:id   - Cancel PI
// POST /payment/stripe/refund       - Issue refund (admin)

import { Hono } from "hono";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { orders, paymentPlans, PaymentStatus, OrderStatus } from "@/db/schema";
import {
  createPaymentIntent,
  capturePaymentIntent,
  cancelPaymentIntent,
  createRefund,
} from "@/lib/payment/stripe";
import { getStripeSettings } from "@/lib/payment/gateway-settings";

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// POST /payment/stripe/intent
// Create a Stripe PaymentIntent for an existing order.
// ---------------------------------------------------------------------------
const intentSchema = z.object({
  orderId: z.string().min(1),
  paymentType: z.enum(["full", "deposit", "balance"]).default("full"),
  depositAmount: z.number().positive().optional(),
  currency: z.string().length(3).default("bdt"),
  manualCapture: z.boolean().default(false),
});

app.post("/intent", async (c) => {
  const db = c.get("db");
  const stripe = await getStripeSettings(db, c.env.CACHE);

  if (!stripe) {
    return c.json({
      success: false,
      error: "Stripe is not configured. Please set credentials in the admin dashboard.",
    }, 503);
  }
  if (!stripe.enabled) {
    return c.json({ success: false, error: "Stripe gateway is disabled." }, 503);
  }

  let body: z.infer<typeof intentSchema>;
  try {
    body = intentSchema.parse(await c.req.json());
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }

  // Fetch the order
  const order = await db
    .select({
      id: orders.id,
      totalAmount: orders.totalAmount,
      status: orders.status,
      paymentStatus: orders.paymentStatus,
      paidAmount: orders.paidAmount,
      balanceDue: orders.balanceDue,
    })
    .from(orders)
    .where(eq(orders.id, body.orderId))
    .get();

  if (!order) return c.json({ success: false, error: "Order not found" }, 404);

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

  // Convert to smallest currency unit (e.g. 1 BDT = 100 paisa)
  const amountInSmallestUnit = Math.round(chargeAmount * 100);

  const result = await createPaymentIntent(stripe.secretKey, {
    orderId: body.orderId,
    amount: amountInSmallestUnit,
    currency: body.currency,
    paymentType: body.paymentType,
    manualCapture: body.manualCapture,
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
      updatedAt: new Date(),
    }).onConflictDoNothing();
  }

  return c.json({
    success: true,
    clientSecret: result.clientSecret,
    paymentIntentId: result.paymentIntentId,
    publishableKey: stripe.publishableKey,
    amount: chargeAmount,
    currency: body.currency,
  });
});

// ---------------------------------------------------------------------------
// POST /payment/stripe/capture/:paymentIntentId
// Capture a manually-authorized PaymentIntent (admin).
// ---------------------------------------------------------------------------
app.post("/capture/:paymentIntentId", async (c) => {
  const db = c.get("db");
  const stripe = await getStripeSettings(db, c.env.CACHE);
  if (!stripe) return c.json({ success: false, error: "Stripe not configured" }, 503);

  const { paymentIntentId } = c.req.param();
  const body = await c.req.json().catch(() => ({})) as { amountToCapture?: number };

  const result = await capturePaymentIntent(
    stripe.secretKey,
    paymentIntentId,
    body.amountToCapture ? Math.round(body.amountToCapture * 100) : undefined
  );

  return c.json(result, result.success ? 200 : 500);
});

// ---------------------------------------------------------------------------
// POST /payment/stripe/cancel/:paymentIntentId
// Cancel an uncaptured PaymentIntent.
// ---------------------------------------------------------------------------
app.post("/cancel/:paymentIntentId", async (c) => {
  const db = c.get("db");
  const stripe = await getStripeSettings(db, c.env.CACHE);
  if (!stripe) return c.json({ success: false, error: "Stripe not configured" }, 503);

  const { paymentIntentId } = c.req.param();
  const result = await cancelPaymentIntent(stripe.secretKey, paymentIntentId);

  if (result.success) {
    await db
      .update(orders)
      .set({ paymentIntentId: null, updatedAt: sql`unixepoch()` })
      .where(eq(orders.paymentIntentId, paymentIntentId));
  }

  return c.json(result, result.success ? 200 : 500);
});

// ---------------------------------------------------------------------------
// POST /payment/stripe/refund
// Issue a partial or full refund for a captured charge (admin).
// ---------------------------------------------------------------------------
const refundSchema = z.object({
  chargeId: z.string().min(1),
  amount: z.number().positive().optional(),
  reason: z.enum(["duplicate", "fraudulent", "requested_by_customer"]).optional(),
});

app.post("/refund", async (c) => {
  const db = c.get("db");
  const stripe = await getStripeSettings(db, c.env.CACHE);
  if (!stripe) return c.json({ success: false, error: "Stripe not configured" }, 503);

  let body: z.infer<typeof refundSchema>;
  try {
    body = refundSchema.parse(await c.req.json());
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }

  const result = await createRefund(
    stripe.secretKey,
    body.chargeId,
    body.amount ? Math.round(body.amount * 100) : undefined,
    body.reason
  );

  return c.json(result, result.success ? 200 : 500);
});

export const stripePaymentRoutes = app;
