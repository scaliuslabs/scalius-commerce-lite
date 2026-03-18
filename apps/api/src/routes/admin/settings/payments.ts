import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { db } from "@scalius/database/client";
import { settings } from "@scalius/database/schema";
import { eq } from "drizzle-orm";
import { getKv } from "../../../utils/kv-cache";
import { ok } from "../../../utils/api-response";
import { ValidationError } from "../../../utils/api-error";
import {
    upsertSetting,
    getActivePaymentMethods,
    getStripeSettings,
    getSSLCommerzSettings,
    getPolarSettings,
    invalidatePaymentMethodsCache,
    invalidateStripeCache,
    invalidateSSLCommerzCache,
    invalidatePolarCache
} from "@scalius/core/modules/payments/gateway-settings";

const app = new OpenAPIHono();
const MASKED = "••••••••••••";

// ─────────────────────────────────────────
// PAYMENT METHODS
// ─────────────────────────────────────────
const updateMethodsSchema = z.object({
    enabledMethods: z.array(z.enum(["stripe", "sslcommerz", "polar", "cod"])).min(1, "At least one payment method is required"),
    defaultMethod: z.enum(["stripe", "sslcommerz", "polar", "cod"])
});

const getPaymentMethodsRoute = createRoute({
    method: "get",
    path: "/payment-methods",
    tags: ["Admin - Settings"],
    summary: "Get active payment methods",
    responses: { 200: { description: "Payment methods config"  } }
});

app.openapi(getPaymentMethodsRoute, async (c) => {
    try {
        const kv = getKv();
        const config = await getActivePaymentMethods(db, kv);

        const stripeSettings = await getStripeSettings(db);
        const sslSettings = await getSSLCommerzSettings(db);
        const polarSettings = await getPolarSettings(db);

        return ok(c, {
            ...config,
            gatewayStatus: {
                stripe: { configured: !!stripeSettings, enabled: stripeSettings?.enabled ?? false },
                sslcommerz: { configured: !!sslSettings, enabled: sslSettings?.enabled ?? false },
                polar: { configured: !!polarSettings, enabled: polarSettings?.enabled ?? false },
                cod: { configured: true, enabled: true }
            }
        });
    } catch (error: unknown) {
        throw error;
    }
});

const savePaymentMethodsRoute = createRoute({
    method: "post",
    path: "/payment-methods",
    tags: ["Admin - Settings"],
    summary: "Save payment methods configuration",
    responses: { 200: { description: "Payment methods saved"  } }
});

app.openapi(savePaymentMethodsRoute, async (c) => {
    try {
        const body = await c.req.json();
        const data = updateMethodsSchema.parse(body);

        if (!data.enabledMethods.includes(data.defaultMethod)) {
            throw new ValidationError("Default method must be one of the enabled methods");
        }

        await Promise.all([
            upsertSetting(db, "payment_methods", "enabled_methods", JSON.stringify(data.enabledMethods)),
            upsertSetting(db, "payment_methods", "default_method", data.defaultMethod),
        ]);

        const kv = getKv();
        await invalidatePaymentMethodsCache(kv);

        return ok(c, { message: "Payment methods updated" });
    } catch (error: unknown) {
        if (error instanceof z.ZodError) throw new ValidationError("Invalid request data");
        throw error;
    }
});

// ─────────────────────────────────────────
// STRIPE
// ─────────────────────────────────────────

const getStripeRoute = createRoute({
    method: "get",
    path: "/stripe",
    tags: ["Admin - Settings"],
    summary: "Get Stripe settings",
    responses: { 200: { description: "Stripe settings"  } }
});

app.openapi(getStripeRoute, async (c) => {
    try {
        const rows = await db.select({ key: settings.key, value: settings.value }).from(settings).where(eq(settings.category, "stripe")).all();
        const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));

        return ok(c, {
            secretKey: map.secret_key ? MASKED : "",
            publishableKey: map.publishable_key ?? "",
            webhookSecret: map.webhook_secret ? MASKED : "",
            enabled: map.enabled !== "false"
        });
    } catch (error: unknown) {
        throw error;
    }
});

const saveStripeRoute = createRoute({
    method: "post",
    path: "/stripe",
    tags: ["Admin - Settings"],
    summary: "Save Stripe settings",
    responses: { 200: { description: "Stripe settings saved"  } }
});

app.openapi(saveStripeRoute, async (c) => {
    try {
        const body = (await c.req.json()) as Record<string, unknown>;
        const ops: Promise<void>[] = [];

        if (typeof body.secretKey === "string" && body.secretKey !== MASKED && body.secretKey.trim()) ops.push(upsertSetting(db, "stripe", "secret_key", body.secretKey.trim()));
        if (typeof body.publishableKey === "string" && body.publishableKey !== MASKED) ops.push(upsertSetting(db, "stripe", "publishable_key", body.publishableKey.trim()));
        if (typeof body.webhookSecret === "string" && body.webhookSecret !== MASKED && body.webhookSecret.trim()) ops.push(upsertSetting(db, "stripe", "webhook_secret", body.webhookSecret.trim()));
        if (typeof body.enabled === "boolean") ops.push(upsertSetting(db, "stripe", "enabled", String(body.enabled)));

        await Promise.all(ops);

        const kv = getKv();
        await Promise.all([invalidateStripeCache(kv), invalidatePaymentMethodsCache(kv)]);

        return ok(c, { message: "Stripe settings saved successfully" });
    } catch (error: unknown) {
        throw error;
    }
});

// ─────────────────────────────────────────
// SSLCOMMERZ
// ─────────────────────────────────────────

const getSSLCommerzRoute = createRoute({
    method: "get",
    path: "/sslcommerz",
    tags: ["Admin - Settings"],
    summary: "Get SSLCommerz settings",
    responses: { 200: { description: "SSLCommerz settings"  } }
});

app.openapi(getSSLCommerzRoute, async (c) => {
    try {
        const rows = await db.select({ key: settings.key, value: settings.value }).from(settings).where(eq(settings.category, "sslcommerz")).all();
        const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));

        return ok(c, {
            storeId: map.store_id ?? "",
            storePassword: map.store_password ? MASKED : "",
            sandbox: map.sandbox !== "false",
            enabled: map.enabled !== "false"
        });
    } catch (error: unknown) {
        throw error;
    }
});

const saveSSLCommerzRoute = createRoute({
    method: "post",
    path: "/sslcommerz",
    tags: ["Admin - Settings"],
    summary: "Save SSLCommerz settings",
    responses: { 200: { description: "SSLCommerz settings saved"  } }
});

app.openapi(saveSSLCommerzRoute, async (c) => {
    try {
        const body = (await c.req.json()) as Record<string, unknown>;
        const ops: Promise<void>[] = [];

        if (typeof body.storeId === "string" && body.storeId.trim()) ops.push(upsertSetting(db, "sslcommerz", "store_id", body.storeId.trim()));
        if (typeof body.storePassword === "string" && body.storePassword !== MASKED && body.storePassword.trim()) ops.push(upsertSetting(db, "sslcommerz", "store_password", body.storePassword.trim()));
        if (typeof body.sandbox === "boolean") ops.push(upsertSetting(db, "sslcommerz", "sandbox", String(body.sandbox)));
        if (typeof body.enabled === "boolean") ops.push(upsertSetting(db, "sslcommerz", "enabled", String(body.enabled)));

        await Promise.all(ops);

        const kv = getKv();
        await Promise.all([invalidateSSLCommerzCache(kv), invalidatePaymentMethodsCache(kv)]);

        return ok(c, { message: "SSLCommerz settings saved successfully" });
    } catch (error: unknown) {
        throw error;
    }
});

// ─────────────────────────────────────────
// POLAR
// ─────────────────────────────────────────

const getPolarRoute = createRoute({
    method: "get",
    path: "/polar",
    tags: ["Admin - Settings"],
    summary: "Get Polar settings",
    responses: { 200: { description: "Polar settings"  } }
});

app.openapi(getPolarRoute, async (c) => {
    try {
        const rows = await db.select({ key: settings.key, value: settings.value }).from(settings).where(eq(settings.category, "polar")).all();
        const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));

        return ok(c, {
            accessToken: map.access_token ? MASKED : "",
            webhookSecret: map.webhook_secret ? MASKED : "",
            productId: map.product_id ?? "",
            sandbox: map.sandbox !== "false",
            enabled: map.enabled !== "false"
        });
    } catch (error: unknown) {
        throw error;
    }
});

const savePolarRoute = createRoute({
    method: "post",
    path: "/polar",
    tags: ["Admin - Settings"],
    summary: "Save Polar settings",
    responses: { 200: { description: "Polar settings saved"  } }
});

app.openapi(savePolarRoute, async (c) => {
    try {
        const body = (await c.req.json()) as Record<string, unknown>;
        const ops: Promise<void>[] = [];

        if (typeof body.accessToken === "string" && body.accessToken !== MASKED && body.accessToken.trim()) ops.push(upsertSetting(db, "polar", "access_token", body.accessToken.trim()));
        if (typeof body.webhookSecret === "string" && body.webhookSecret !== MASKED && body.webhookSecret.trim()) ops.push(upsertSetting(db, "polar", "webhook_secret", body.webhookSecret.trim()));
        if (typeof body.productId === "string" && body.productId.trim()) ops.push(upsertSetting(db, "polar", "product_id", body.productId.trim()));
        if (typeof body.sandbox === "boolean") ops.push(upsertSetting(db, "polar", "sandbox", String(body.sandbox)));
        if (typeof body.enabled === "boolean") ops.push(upsertSetting(db, "polar", "enabled", String(body.enabled)));

        await Promise.all(ops);

        const kv = getKv();
        await Promise.all([invalidatePolarCache(kv), invalidatePaymentMethodsCache(kv)]);

        return ok(c, { message: "Polar settings saved successfully" });
    } catch (error: unknown) {
        throw error;
    }
});

export { app as paymentSettingsRoutes };
