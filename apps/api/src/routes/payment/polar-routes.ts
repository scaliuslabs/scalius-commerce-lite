// src/server/routes/payment/polar-routes.ts
// Hono API routes for Polar payment operations (storefront-initiated).

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { type Database } from "@scalius/database/client";
import { orders, paymentPlans, PaymentMethod } from "@scalius/database/schema";
import { eq } from "drizzle-orm";
import { getPolarSettings } from "@scalius/core/modules/payments/gateway-settings";
import { createPolarCheckout } from "@scalius/core/modules/payments/polar";
import { getKv } from "../../utils/kv-cache";
import { getCurrencyConfig } from "@scalius/core/modules/settings/settings.service";
import { NotFoundError } from "../../utils/api-error";

import { ok } from "../../utils/api-response";
export const polarPaymentRoutes = new OpenAPIHono<{ Bindings: Env }>();

// ─── POST /session ───────────────────────────────────────────────────────────

const polarSessionSchema = z.object({
    orderId: z.string().min(1),
    depositAmount: z.number().positive().optional(),
    currency: z.string().optional(),
    type: z.enum(["full", "deposit", "balance"]).optional(),
    paymentType: z.enum(["full", "deposit", "balance"]).optional(),
    customerName: z.string().optional(),
    customerEmail: z.string().optional(),
    customerPhone: z.string().optional(),
    successUrl: z.string().optional(),
    cancelUrl: z.string().optional()
});

const createPolarSessionRoute = createRoute({
    method: "post",
    path: "/session",
    tags: ["Payments - Polar"],
    summary: "Create a Polar checkout session",
    request: {
        body: {
            content: {
                "application/json": { schema: polarSessionSchema }
            }
        }
    },
    responses: {
        200: { description: "Polar checkout session created"  },
        400: { description: "Invalid request"  },
        404: { description: "Order not found"  },
        503: { description: "Polar not configured"  }
    }
});

polarPaymentRoutes.openapi(createPolarSessionRoute, async (c) => {
    const body = c.req.valid("json");
    const orderId = body.orderId;
    const type = body.paymentType || body.type || "full";

    const db: Database = c.get("db");
    const kv = getKv();

    // Get Polar credentials from DB
    const polarSettings = await getPolarSettings(db, kv);
    if (!polarSettings || !polarSettings.enabled) {
        return c.json({ error: "Polar is not configured or disabled" }, 503);
    }

    // Validate the order exists
    const order = await db
        .select({
            id: orders.id,
            totalAmount: orders.totalAmount,
            status: orders.status,
            paymentMethod: orders.paymentMethod,
            paymentStatus: orders.paymentStatus,
            paidAmount: orders.paidAmount
        })
        .from(orders)
        .where(eq(orders.id, orderId))
        .get();

    if (!order) throw new NotFoundError("Order not found");

    // Get configured currency
    const currencyConfig = await getCurrencyConfig(db);
    const currency = (body.currency ?? currencyConfig.code).toLowerCase();

    // Determine the correct amount based on payment type
    let paymentAmount = order.totalAmount;
    if (type === "deposit") {
        paymentAmount = body.depositAmount || order.totalAmount;
    } else if (type === "balance") {
        const plan = await db
            .select()
            .from(paymentPlans)
            .where(eq(paymentPlans.orderId, orderId))
            .get();
        if (plan) {
            paymentAmount = plan.balanceDue;
        }
    }

    const amountInCents = Math.round(paymentAmount * 100);

    const baseUrl = (c.env.PUBLIC_API_BASE_URL || new URL(c.req.url).origin).trim();
    const successUrl = body.successUrl || `${baseUrl}/api/v1/payment/polar/success?order_id=${orderId}`;

    const result = await createPolarCheckout(polarSettings, {
        orderId,
        amount: amountInCents,
        currency,
        productId: polarSettings.productId,
        paymentType: type,
        successUrl,
        cancelUrl: body.cancelUrl,
        customerName: body.customerName,
        customerEmail: body.customerEmail,
        metadata: {
            orderId,
            paymentType: type
        }
    });

    if (!result.success || !result.checkoutUrl) {
        return c.json(
            { error: result.error || "Failed to create Polar checkout" },
            500
        );
    }

    // Save the Polar checkout ID to the order
    await db
        .update(orders)
        .set({
            paymentIntentId: result.checkoutId,
            paymentMethod: PaymentMethod.POLAR,
            updatedAt: new Date()
        })
        .where(eq(orders.id, orderId));

    // Set up payment plan for deposit orders
    if (type === "deposit") {
        const depositAmount = paymentAmount;
        const balanceDue = order.totalAmount - depositAmount;

        await db
            .insert(paymentPlans)
            .values({
                id: crypto.randomUUID(),
                orderId,
                totalAmount: order.totalAmount,
                depositAmount,
                balanceDue,
                status: "pending"
            })
            .onConflictDoUpdate({
                target: paymentPlans.orderId,
                set: {
                    depositAmount,
                    balanceDue,
                    updatedAt: new Date()
                }
            });
    }

    return ok(c, {
        success: true,
        gatewayUrl: result.checkoutUrl,
        checkoutId: result.checkoutId
    });
});

// ─── GET /success ────────────────────────────────────────────────────────────
// Redirect handlers — not OpenAPI routes (external callbacks)

polarPaymentRoutes.get("/success", async (c) => {
    const orderId = c.req.query("order_id");

    const envObj = c.env;
    const storefrontUrl = envObj.STOREFRONT_URL || envObj.PUBLIC_STOREFRONT_URL || "";

    if (orderId && storefrontUrl) {
        return c.redirect(`${storefrontUrl}/order-success?orderId=${orderId}&payment=polar`);
    }

    return c.json({ success: true, message: "Payment received", orderId });
});

// ─── GET /cancel ─────────────────────────────────────────────────────────────

polarPaymentRoutes.get("/cancel", async (c) => {
    const orderId = c.req.query("order_id");

    const envObj = c.env;
    const storefrontUrl = envObj.STOREFRONT_URL || envObj.PUBLIC_STOREFRONT_URL || "";

    if (storefrontUrl) {
        return c.redirect(`${storefrontUrl}/checkout?error=payment_cancelled&payment=polar`);
    }

    return c.json({ success: false, message: "Payment cancelled", orderId });
});
