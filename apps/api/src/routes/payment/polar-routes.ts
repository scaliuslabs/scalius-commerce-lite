// src/server/routes/payment/polar-routes.ts
// Hono API routes for Polar payment operations (storefront-initiated).

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { type Database } from "@scalius/database/client";
import { orders, paymentPlans, PaymentMethod } from "@scalius/database/schema";
import { eq, sql } from "drizzle-orm";
import { getPolarSettings } from "@scalius/core/modules/payments/gateway-settings";
import { createPolarCheckout } from "@scalius/core/modules/payments/polar";
import { getKv } from "../../utils/kv-cache";
import { getCurrencyConfig } from "@scalius/core/modules/settings/settings.service";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { NotFoundError, ServiceUnavailableError, ApiError } from "../../utils/api-error";
import { getEncryptionKey } from "../../utils/encryption-key";
import { successEnvelope, errorResponses } from "../../schemas/responses";

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
        200: {
            description: "Polar checkout session created",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        gatewayUrl: z.string().optional(),
                        checkoutId: z.string().optional(),
                    })),
                },
            },
        },
        ...errorResponses,
    }
});

polarPaymentRoutes.openapi(createPolarSessionRoute, async (c) => {
    const body = c.req.valid("json");
    const orderId = body.orderId;
    const type = body.paymentType || body.type || "full";

    const db: Database = c.get("db");
    const kv = getKv();
    const encryptionKey = getEncryptionKey(c.env as Record<string, unknown>);

    // Get Polar credentials from DB
    const polarSettings = await getPolarSettings(db, kv, encryptionKey);
    if (!polarSettings || !polarSettings.enabled) {
        throw new ServiceUnavailableError("Polar is not configured or disabled");
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
    let currency = (body.currency ?? currencyConfig.code).toLowerCase();

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

    // Polar only supports specific currencies. If the store currency isn't
    // supported, convert the amount to USD using the configured exchange rate.
    const POLAR_SUPPORTED_CURRENCIES = new Set([
        "aed", "ars", "aud", "brl", "cad", "chf", "clp", "cny", "cop", "czk",
        "dkk", "eur", "gbp", "hkd", "huf", "idr", "ils", "inr", "jpy", "krw",
        "mxn", "myr", "nok", "nzd", "pen", "php", "pln", "ron", "sar", "sek",
        "sgd", "thb", "try", "twd", "usd", "zar",
    ]);

    if (!POLAR_SUPPORTED_CURRENCIES.has(currency)) {
        const rate = currencyConfig.usdExchangeRate;
        if (!rate || rate <= 0) {
            throw new ApiError(400, "CURRENCY_ERROR",
                `Currency "${currency.toUpperCase()}" is not supported by Polar and no USD exchange rate is configured. ` +
                `Please set a USD exchange rate in Settings > Currency.`
            );
        }
        console.log(`[Polar] Converting ${currency.toUpperCase()} → USD at rate ${rate} for order ${orderId}`);
        paymentAmount = Math.round((paymentAmount / rate) * 100) / 100; // Round to 2 decimals
        currency = "usd";
    }

    // Convert major-unit amount to smallest currency unit using ISO 4217 decimals.
    // e.g. USD/BDT: ×100, JPY: ×1, BHD: ×1000
    const decimals = getDecimalPlaces(currency);
    const amountInCents = Math.round(paymentAmount * Math.pow(10, decimals));

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
        throw new ApiError(500, "PAYMENT_ERROR", result.error || "Failed to create Polar checkout");
    }

    // Save the Polar checkout ID to the order
    await db
        .update(orders)
        .set({
            paymentIntentId: result.checkoutId,
            paymentMethod: PaymentMethod.POLAR,
            updatedAt: sql`unixepoch()`
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
                    updatedAt: sql`unixepoch()`
                }
            });
    }

    return ok(c, {
        gatewayUrl: result.checkoutUrl,
        checkoutId: result.checkoutId
    });
});

// ─── GET /success ────────────────────────────────────────────────────────────
// Redirect handlers — not OpenAPI routes (external callbacks)

polarPaymentRoutes.get("/success", async (c) => {
    const orderId = c.req.query("order_id");

    const envObj = c.env;
    const storefrontUrl = String(envObj.STOREFRONT_URL || envObj.PUBLIC_STOREFRONT_URL || "").replace(/\/+$/, "");

    if (storefrontUrl) {
        if (orderId) {
            const db: Database = c.get("db");
            const order = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).get();
            if (!order) return c.redirect(`${storefrontUrl}/checkout?error=invalid_order`);
        }
        return c.redirect(`${storefrontUrl}/order-success?orderId=${orderId ?? ""}&payment=polar`);
    }

    return c.redirect("/");
});

// ─── GET /cancel ─────────────────────────────────────────────────────────────

polarPaymentRoutes.get("/cancel", async (c) => {
    const orderId = c.req.query("order_id");

    const envObj = c.env;
    const storefrontUrl = String(envObj.STOREFRONT_URL || envObj.PUBLIC_STOREFRONT_URL || "").replace(/\/+$/, "");

    if (storefrontUrl) {
        return c.redirect(`${storefrontUrl}/checkout?error=payment_cancelled&payment=polar`);
    }

    return c.redirect("/");
});
