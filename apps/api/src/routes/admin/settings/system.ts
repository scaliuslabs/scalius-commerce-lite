import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { db } from "@scalius/database/client";
import { settings, siteSettings } from "@scalius/database/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";

import { getKv } from "../../../utils/kv-cache";
import { invalidateSiteSettingsCache } from "@scalius/core/modules/settings";

import { ok } from "../../../utils/api-response";
const app = new OpenAPIHono();
const MASKED = "••••••••••••";

// ─────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────

const getAuthRoute = createRoute({
    method: "get",
    path: "/auth",
    tags: ["Admin - Settings"],
    summary: "Get auth/checkout settings",
    responses: { 200: { description: "Auth settings"  } }
});

app.openapi(getAuthRoute, async (c) => {
    try {
        const [row] = await db.select().from(siteSettings).limit(1);
        if (!row) return c.json({ message: "Settings not found" }, 404);

        return ok(c, {
            authVerificationMethod: row.authVerificationMethod,
            guestCheckoutEnabled: row.guestCheckoutEnabled,
            whatsappAccessToken: row.whatsappAccessToken ? MASKED : "",
            whatsappPhoneNumberId: row.whatsappPhoneNumberId || "",
            whatsappTemplateName: row.whatsappTemplateName || "",
            checkoutMode: row.checkoutMode,
            partialPaymentEnabled: row.partialPaymentEnabled,
            partialPaymentAmount: row.partialPaymentAmount
        });
    } catch (error) {
        return c.json({ message: "Error fetching auth settings" }, 500);
    }
});

const saveAuthRoute = createRoute({
    method: "post",
    path: "/auth",
    tags: ["Admin - Settings"],
    summary: "Save auth/checkout settings",
    responses: { 200: { description: "Auth settings saved"  } }
});

app.openapi(saveAuthRoute, async (c) => {
    try {
        const body = (await c.req.json()) as Record<string, unknown>;
        const [existingSettings] = await db.select().from(siteSettings).limit(1);

        if (!existingSettings) return c.json({ message: "Base Site Settings must be configured first" }, 400);

        const updates: Partial<typeof siteSettings.$inferInsert> = {};

        if (body.authVerificationMethod && typeof body.authVerificationMethod === "string") {
            updates.authVerificationMethod = body.authVerificationMethod as "email" | "phone" | "both" | "whatsapp_otp" | "sms_otp";
        }
        if (typeof body.guestCheckoutEnabled === "boolean") updates.guestCheckoutEnabled = body.guestCheckoutEnabled;
        if (typeof body.whatsappPhoneNumberId === "string" || body.whatsappPhoneNumberId === null) {
            updates.whatsappPhoneNumberId = body.whatsappPhoneNumberId as string | null;
        }
        if (typeof body.whatsappTemplateName === "string" || body.whatsappTemplateName === null) {
            updates.whatsappTemplateName = body.whatsappTemplateName as string | null;
        }
        if (body.checkoutMode && typeof body.checkoutMode === "string") {
            updates.checkoutMode = body.checkoutMode as "guest_cod_only" | "gateways_only" | "all";
        }
        if (typeof body.partialPaymentEnabled === "boolean") updates.partialPaymentEnabled = body.partialPaymentEnabled;
        if (typeof body.partialPaymentAmount === "number") updates.partialPaymentAmount = body.partialPaymentAmount;

        if (typeof body.whatsappAccessToken === "string" && body.whatsappAccessToken !== MASKED) {
            updates.whatsappAccessToken = body.whatsappAccessToken;
        }

        await db
            .update(siteSettings)
            .set(updates)
            .where(eq(siteSettings.id, existingSettings.id));

        await invalidateSiteSettingsCache(getKv());
        return ok(c, { message: "Auth settings saved successfully" });
    } catch (error) {
        return c.json({ message: "Error saving auth settings" }, 500);
    }
});

// ─────────────────────────────────────────
// SECURITY
// ─────────────────────────────────────────

const getSecurityRoute = createRoute({
    method: "get",
    path: "/security",
    tags: ["Admin - Settings"],
    summary: "Get security settings",
    responses: { 200: { description: "Security settings"  } }
});

app.openapi(getSecurityRoute, async (c) => {
    try {
        const row = await db
            .select({ value: settings.value })
            .from(settings)
            .where(and(eq(settings.key, "csp_allowed_domains"), eq(settings.category, "security")))
            .get();

        return ok(c, { cspAllowedDomains: row?.value || "" });
    } catch (error) {
        return c.json({ message: "Error fetching security settings" }, 500);
    }
});

const saveSecurityRoute = createRoute({
    method: "post",
    path: "/security",
    tags: ["Admin - Settings"],
    summary: "Save security settings",
    responses: { 200: { description: "Security settings saved"  } }
});

app.openapi(saveSecurityRoute, async (c) => {
    try {
        const { cspAllowedDomains } = await c.req.json();

        if (typeof cspAllowedDomains === "string") {
            await db
                .insert(settings)
                .values({
                    id: `set_${nanoid(10)}`,
                    key: "csp_allowed_domains",
                    value: cspAllowedDomains,
                    type: "string",
                    category: "security"
                })
                .onConflictDoUpdate({
                    target: [settings.key, settings.category],
                    set: { value: cspAllowedDomains, updatedAt: new Date() }
                });

            const env = c.env as Env | undefined;
            if (env?.CACHE) {
                c.executionCtx.waitUntil(env.CACHE.put("security:csp_allowed_domains", cspAllowedDomains));
            }
        }

        return ok(c, { message: "Security settings saved successfully" });
    } catch (error) {
        return c.json({ message: "Error saving security settings" }, 500);
    }
});

// ─────────────────────────────────────────
// EMAIL
// ─────────────────────────────────────────

const getEmailRoute = createRoute({
    method: "get",
    path: "/email",
    tags: ["Admin - Settings"],
    summary: "Get email settings (system)",
    responses: { 200: { description: "Email settings"  } }
});

app.openapi(getEmailRoute, async (c) => {
    try {
        const [apiKeyRow, senderRow] = await Promise.all([
            db.select({ value: settings.value }).from(settings).where(and(eq(settings.key, "resend_api_key"), eq(settings.category, "email"))).get(),
            db.select({ value: settings.value }).from(settings).where(and(eq(settings.key, "email_sender"), eq(settings.category, "email"))).get(),
        ]);

        return ok(c, {
            apiKey: apiKeyRow?.value ? MASKED : "",
            sender: senderRow?.value || ""
        });
    } catch (error) {
        return c.json({ message: "Error fetching email settings" }, 500);
    }
});

const saveEmailRoute = createRoute({
    method: "post",
    path: "/email",
    tags: ["Admin - Settings"],
    summary: "Save email settings (system)",
    responses: { 200: { description: "Email settings saved"  } }
});

app.openapi(saveEmailRoute, async (c) => {
    try {
        const { apiKey, sender } = await c.req.json();
        const updates: Promise<unknown>[] = [];

        if (typeof apiKey === "string" && apiKey !== MASKED) {
            updates.push(
                db.insert(settings)
                    .values({ id: `set_${nanoid(10)}`, key: "resend_api_key", value: apiKey, type: "string", category: "email" })
                    .onConflictDoUpdate({ target: [settings.key, settings.category], set: { value: apiKey, updatedAt: new Date() } })
            );
        }

        if (typeof sender === "string") {
            updates.push(
                db.insert(settings)
                    .values({ id: `set_${nanoid(10)}`, key: "email_sender", value: sender, type: "string", category: "email" })
                    .onConflictDoUpdate({ target: [settings.key, settings.category], set: { value: sender, updatedAt: new Date() } })
            );
        }

        await Promise.all(updates);
        return ok(c, { message: "Email settings saved successfully" });
    } catch (error) {
        return c.json({ message: "Error saving email settings" }, 500);
    }
});

// ─────────────────────────────────────────
// FIREBASE
// ─────────────────────────────────────────

const getFirebaseRoute = createRoute({
    method: "get",
    path: "/firebase",
    tags: ["Admin - Settings"],
    summary: "Get Firebase settings (system)",
    responses: { 200: { description: "Firebase settings"  } }
});

app.openapi(getFirebaseRoute, async (c) => {
    try {
        const results = await db.select({ key: settings.key, value: settings.value }).from(settings).where(eq(settings.category, "firebase")).all();

        const config: { serviceAccount: string; publicConfig: Record<string, unknown> } = { serviceAccount: "", publicConfig: {} };

        results.forEach((row) => {
            if (row.key === "service_account") config.serviceAccount = row.value ? MASKED : "";
            if (row.key === "public_config") {
                try { config.publicConfig = JSON.parse(row.value); } catch (_) { config.publicConfig = {}; }
            }
        });

        return ok(c, config);
    } catch (error) {
        return c.json({ error: "Internal Server Error" }, 500);
    }
});

const saveFirebaseRoute = createRoute({
    method: "post",
    path: "/firebase",
    tags: ["Admin - Settings"],
    summary: "Save Firebase settings (system)",
    responses: { 200: { description: "Firebase settings saved"  } }
});

app.openapi(saveFirebaseRoute, async (c) => {
    try {
        const { serviceAccount, publicConfig } = await c.req.json();
        const updates: Promise<unknown>[] = [];

        if (serviceAccount && serviceAccount !== MASKED) {
            try {
                JSON.parse(serviceAccount);
                updates.push(
                    db.insert(settings)
                        .values({ id: `set_${nanoid(10)}`, key: "service_account", value: serviceAccount, type: "json", category: "firebase" })
                        .onConflictDoUpdate({ target: [settings.key, settings.category], set: { value: serviceAccount, updatedAt: new Date() } })
                );
            } catch (e) {
                return c.json({ error: "Invalid Service Account JSON" }, 400);
            }
        }

        if (publicConfig) {
            updates.push(
                db.insert(settings)
                    .values({ id: `set_${nanoid(10)}`, key: "public_config", value: JSON.stringify(publicConfig), type: "json", category: "firebase" })
                    .onConflictDoUpdate({ target: [settings.key, settings.category], set: { value: JSON.stringify(publicConfig), updatedAt: new Date() } })
            );
        }

        await Promise.all(updates);

        const { layoutCache, CACHE_KEYS } = await import("@scalius/shared/layout-cache");
        layoutCache.invalidate(CACHE_KEYS.FIREBASE_CONFIG);

        return ok(c, { message: "Settings saved successfully" });
    } catch (error) {
        return c.json({ error: "Internal Server Error" }, 500);
    }
});

export { app as systemSettingsRoutes };
