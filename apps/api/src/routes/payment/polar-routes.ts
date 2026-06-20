// src/server/routes/payment/polar-routes.ts
// Hono API routes for Polar payment operations (storefront-initiated).

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { type Database } from "@scalius/database/client";
import { orders } from "@scalius/database/schema";
import { eq } from "drizzle-orm";
import { validateReceiptToken } from "../../utils/order-receipt-token";
import { successEnvelope, errorResponses, serviceUnavailableResponse } from "../../schemas/responses";
import { ok } from "../../utils/api-response";
import { createPolarPaymentSession } from "./payment-session-create";

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
    receiptToken: z.string().min(1),
    retryKey: z.string().trim().min(1).max(128).optional()
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
        503: serviceUnavailableResponse,
    }
});

polarPaymentRoutes.openapi(createPolarSessionRoute, async (c) => {
    const body = c.req.valid("json");
    const orderId = body.orderId;

    const db: Database = c.get("db");
    await validateReceiptToken(c.env.CACHE, orderId, body.receiptToken, db);

    const result = await createPolarPaymentSession(c, {
        orderId,
        paymentType: body.paymentType || body.type,
        depositAmount: body.depositAmount,
        retryKey: body.retryKey,
        proof: { kind: "receipt", receiptToken: body.receiptToken },
        returnTarget: { kind: "receipt", receiptToken: body.receiptToken },
    });

    return ok(c, result.hosted);
});

// ─── GET /success ────────────────────────────────────────────────────────────
// Redirect handlers — not OpenAPI routes (external callbacks)

function getConfiguredStorefrontUrl(env: { STOREFRONT_URL?: string; PUBLIC_STOREFRONT_URL?: string }): string {
    return String(env.STOREFRONT_URL || env.PUBLIC_STOREFRONT_URL || "").replace(/\/+$/, "");
}

function normalizeCallbackPaymentType(value: string | undefined): "full" | "deposit" | "balance" | "" {
    if (value === "full" || value === "deposit" || value === "balance") return value;
    return "";
}

function getCallbackPaymentType(c: { req: { query: (key: string) => string | undefined } }): "full" | "deposit" | "balance" | "" {
    return normalizeCallbackPaymentType(c.req.query("payment_type") ?? c.req.query("paymentType"));
}

function getCallbackDepositAmount(c: { req: { query: (key: string) => string | undefined } }): string {
    const value = c.req.query("deposit_amount") ?? c.req.query("depositAmount") ?? "";
    if (!value) return "";
    const amount = Number(value);
    return Number.isFinite(amount) && amount > 0 ? value : "";
}

function shouldReturnToAccount(c: { req: { query: (key: string) => string | undefined } }): boolean {
    return c.req.query("return_to") === "account" || c.req.query("returnTo") === "account";
}

function buildStorefrontOrderSuccessUrl(
    storefront: string,
    params: {
        orderId: string;
        receiptToken: string;
        payment: "polar";
        result?: "cancelled";
        paymentType?: "full" | "deposit" | "balance" | "";
        depositAmount?: string;
    },
): string {
    const url = new URL(`${storefront}/order-success`);
    url.searchParams.set("orderId", params.orderId);
    url.searchParams.set("token", params.receiptToken);
    url.searchParams.set("payment", params.payment);
    if (params.result) url.searchParams.set("result", params.result);
    if (params.paymentType) url.searchParams.set("paymentType", params.paymentType);
    if (params.depositAmount) url.searchParams.set("depositAmount", params.depositAmount);
    return url.toString();
}

function buildStorefrontAccountOrderUrl(
    storefront: string,
    params: {
        orderId: string;
        payment: "polar";
        result?: "cancelled";
        paymentType?: "full" | "deposit" | "balance" | "";
    },
): string {
    const url = new URL(`${storefront}/account/orders/${encodeURIComponent(params.orderId)}`);
    url.searchParams.set("payment", params.payment);
    if (params.result) url.searchParams.set("result", params.result);
    if (params.paymentType) url.searchParams.set("paymentType", params.paymentType);
    return url.toString();
}

async function validateCallbackOrder(db: Pick<Database, "select">, orderId: string, storefrontUrl: string): Promise<string | null> {
    if (!orderId) return null;
    const order = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).get();
    return order ? null : `${storefrontUrl}/checkout?error=invalid_order`;
}

polarPaymentRoutes.get("/success", async (c) => {
    const orderId = c.req.query("order_id");
    const receiptToken = c.req.query("receipt_token") ?? "";
    const paymentType = getCallbackPaymentType(c);
    const depositAmount = getCallbackDepositAmount(c);

    const envObj = c.env;
    const storefrontUrl = getConfiguredStorefrontUrl(envObj);

    if (storefrontUrl) {
        if (orderId) {
            const db: Database = c.get("db");
            const invalidRedirect = await validateCallbackOrder(db, orderId, storefrontUrl);
            if (invalidRedirect) return c.redirect(invalidRedirect);
        }
        if (shouldReturnToAccount(c) && orderId) {
            return c.redirect(buildStorefrontAccountOrderUrl(storefrontUrl, {
                orderId,
                payment: "polar",
                paymentType,
            }));
        }
        if (!receiptToken) return c.redirect(`${storefrontUrl}/checkout?error=payment_return_missing_receipt&payment=polar`);
        return c.redirect(buildStorefrontOrderSuccessUrl(storefrontUrl, {
            orderId: orderId ?? "",
            receiptToken,
            payment: "polar",
            paymentType,
            depositAmount,
        }));
    }

    return c.redirect("/");
});

// ─── GET /cancel ─────────────────────────────────────────────────────────────

polarPaymentRoutes.get("/cancel", async (c) => {
    const envObj = c.env;
    const storefrontUrl = getConfiguredStorefrontUrl(envObj);
    const orderId = c.req.query("order_id") ?? "";
    const receiptToken = c.req.query("receipt_token") ?? "";

    if (storefrontUrl) {
        if (orderId) {
            const db: Database = c.get("db");
            const invalidRedirect = await validateCallbackOrder(db, orderId, storefrontUrl);
            if (invalidRedirect) return c.redirect(invalidRedirect);
        }
        if (shouldReturnToAccount(c) && orderId) {
            return c.redirect(buildStorefrontAccountOrderUrl(storefrontUrl, {
                orderId,
                payment: "polar",
                result: "cancelled",
                paymentType: getCallbackPaymentType(c),
            }));
        }
        if (!receiptToken) {
            return c.redirect(`${storefrontUrl}/checkout?error=payment_cancelled&payment=polar`);
        }
        return c.redirect(buildStorefrontOrderSuccessUrl(storefrontUrl, {
            orderId,
            receiptToken,
            payment: "polar",
            result: "cancelled",
            paymentType: getCallbackPaymentType(c),
            depositAmount: getCallbackDepositAmount(c),
        }));
    }

    return c.redirect("/");
});
