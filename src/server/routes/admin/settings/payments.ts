import { Hono } from "hono";
import { z } from "zod";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getKv } from "@/server/utils/kv-cache";
import {
    upsertSetting,
    getActivePaymentMethods,
    getStripeSettings,
    getSSLCommerzSettings,
    getPolarSettings,
    invalidatePaymentMethodsCache,
    invalidateStripeCache,
    invalidateSSLCommerzCache,
    invalidatePolarCache,
} from "@/modules/payments/gateway-settings";

const app = new Hono<{ Bindings: any, Variables: any }>();
const MASKED = "••••••••••••";

// ─────────────────────────────────────────
// PAYMENT METHODS
// ─────────────────────────────────────────
const updateMethodsSchema = z.object({
    enabledMethods: z.array(z.enum(["stripe", "sslcommerz", "polar", "cod"])).min(1, "At least one payment method is required"),
    defaultMethod: z.enum(["stripe", "sslcommerz", "polar", "cod"]),
});

app.get("/payment-methods", async (c) => {
    try {
        const kv = getKv();
        const config = await getActivePaymentMethods(db, kv);

        const stripeSettings = await getStripeSettings(db);
        const sslSettings = await getSSLCommerzSettings(db);
        const polarSettings = await getPolarSettings(db);

        return c.json({
            ...config,
            gatewayStatus: {
                stripe: { configured: !!stripeSettings, enabled: stripeSettings?.enabled ?? false },
                sslcommerz: { configured: !!sslSettings, enabled: sslSettings?.enabled ?? false },
                polar: { configured: !!polarSettings, enabled: polarSettings?.enabled ?? false },
                cod: { configured: true, enabled: true },
            },
        });
    } catch (error) {
        return c.json({ error: "Failed to fetch payment methods" }, 500);
    }
});

app.post("/payment-methods", async (c) => {
    try {
        const body = await c.req.json();
        const data = updateMethodsSchema.parse(body);

        if (!data.enabledMethods.includes(data.defaultMethod)) {
            return c.json({ error: "Default method must be one of the enabled methods" }, 400);
        }

        await Promise.all([
            upsertSetting(db, "payment_methods", "enabled_methods", JSON.stringify(data.enabledMethods)),
            upsertSetting(db, "payment_methods", "default_method", data.defaultMethod),
        ]);

        const kv = getKv();
        await invalidatePaymentMethodsCache(kv);

        return c.json({ success: true, message: "Payment methods updated" });
    } catch (error: any) {
        if (error instanceof z.ZodError) return c.json({ error: "Invalid request data", details: error.issues }, 400);
        return c.json({ error: "Failed to save payment methods" }, 500);
    }
});

// ─────────────────────────────────────────
// STRIPE
// ─────────────────────────────────────────
app.get("/stripe", async (c) => {
    try {
        const rows = await db.select({ key: settings.key, value: settings.value }).from(settings).where(eq(settings.category, "stripe")).all();
        const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));

        return c.json({
            secretKey: map.secret_key ? MASKED : "",
            publishableKey: map.publishable_key ?? "",
            webhookSecret: map.webhook_secret ? MASKED : "",
            enabled: map.enabled !== "false",
        });
    } catch (error) {
        return c.json({ message: "Error fetching Stripe settings" }, 500);
    }
});

app.post("/stripe", async (c) => {
    try {
        const body = (await c.req.json()) as any;
        const ops: Promise<void>[] = [];

        if (typeof body.secretKey === "string" && body.secretKey !== MASKED && body.secretKey.trim()) ops.push(upsertSetting(db, "stripe", "secret_key", body.secretKey.trim()));
        if (typeof body.publishableKey === "string" && body.publishableKey !== MASKED) ops.push(upsertSetting(db, "stripe", "publishable_key", body.publishableKey.trim()));
        if (typeof body.webhookSecret === "string" && body.webhookSecret !== MASKED && body.webhookSecret.trim()) ops.push(upsertSetting(db, "stripe", "webhook_secret", body.webhookSecret.trim()));
        if (typeof body.enabled === "boolean") ops.push(upsertSetting(db, "stripe", "enabled", String(body.enabled)));

        await Promise.all(ops);

        const kv = getKv();
        await Promise.all([invalidateStripeCache(kv), invalidatePaymentMethodsCache(kv)]);

        return c.json({ message: "Stripe settings saved successfully" });
    } catch (error) {
        return c.json({ message: "Error saving Stripe settings" }, 500);
    }
});

// ─────────────────────────────────────────
// SSLCOMMERZ
// ─────────────────────────────────────────
app.get("/sslcommerz", async (c) => {
    try {
        const rows = await db.select({ key: settings.key, value: settings.value }).from(settings).where(eq(settings.category, "sslcommerz")).all();
        const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));

        return c.json({
            storeId: map.store_id ?? "",
            storePassword: map.store_password ? MASKED : "",
            sandbox: map.sandbox !== "false",
            enabled: map.enabled !== "false",
        });
    } catch (error) {
        return c.json({ message: "Error fetching SSLCommerz settings" }, 500);
    }
});

app.post("/sslcommerz", async (c) => {
    try {
        const body = (await c.req.json()) as any;
        const ops: Promise<void>[] = [];

        if (typeof body.storeId === "string" && body.storeId.trim()) ops.push(upsertSetting(db, "sslcommerz", "store_id", body.storeId.trim()));
        if (typeof body.storePassword === "string" && body.storePassword !== MASKED && body.storePassword.trim()) ops.push(upsertSetting(db, "sslcommerz", "store_password", body.storePassword.trim()));
        if (typeof body.sandbox === "boolean") ops.push(upsertSetting(db, "sslcommerz", "sandbox", String(body.sandbox)));
        if (typeof body.enabled === "boolean") ops.push(upsertSetting(db, "sslcommerz", "enabled", String(body.enabled)));

        await Promise.all(ops);

        const kv = getKv();
        await Promise.all([invalidateSSLCommerzCache(kv), invalidatePaymentMethodsCache(kv)]);

        return c.json({ message: "SSLCommerz settings saved successfully" });
    } catch (error) {
        return c.json({ message: "Error saving SSLCommerz settings" }, 500);
    }
});

// ─────────────────────────────────────────
// POLAR
// ─────────────────────────────────────────
app.get("/polar", async (c) => {
    try {
        const rows = await db.select({ key: settings.key, value: settings.value }).from(settings).where(eq(settings.category, "polar")).all();
        const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));

        return c.json({
            accessToken: map.access_token ? MASKED : "",
            webhookSecret: map.webhook_secret ? MASKED : "",
            productId: map.product_id ?? "",
            sandbox: map.sandbox !== "false",
            enabled: map.enabled !== "false",
        });
    } catch (error) {
        return c.json({ message: "Error fetching Polar settings" }, 500);
    }
});

app.post("/polar", async (c) => {
    try {
        const body = (await c.req.json()) as any;
        const ops: Promise<void>[] = [];

        if (typeof body.accessToken === "string" && body.accessToken !== MASKED && body.accessToken.trim()) ops.push(upsertSetting(db, "polar", "access_token", body.accessToken.trim()));
        if (typeof body.webhookSecret === "string" && body.webhookSecret !== MASKED && body.webhookSecret.trim()) ops.push(upsertSetting(db, "polar", "webhook_secret", body.webhookSecret.trim()));
        if (typeof body.productId === "string" && body.productId.trim()) ops.push(upsertSetting(db, "polar", "product_id", body.productId.trim()));
        if (typeof body.sandbox === "boolean") ops.push(upsertSetting(db, "polar", "sandbox", String(body.sandbox)));
        if (typeof body.enabled === "boolean") ops.push(upsertSetting(db, "polar", "enabled", String(body.enabled)));

        await Promise.all(ops);

        const kv = getKv();
        await Promise.all([invalidatePolarCache(kv), invalidatePaymentMethodsCache(kv)]);

        return c.json({ message: "Polar settings saved successfully" });
    } catch (error) {
        return c.json({ message: "Error saving Polar settings" }, 500);
    }
});

export { app as paymentSettingsRoutes };
