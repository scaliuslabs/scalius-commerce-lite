import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { settings, siteSettings } from "@scalius/database/schema";
import { eq, and, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

import { getKv } from "../../../utils/kv-cache";
import { invalidateSiteSettingsCache } from "@scalius/core/modules/settings";
import { getEncryptionKey } from "../../../utils/encryption-key";
import { upsertEncryptedSetting } from "@scalius/core/modules/payments/gateway-settings";
import { invalidateApiAndStorefrontGroups } from "../../../utils/cache-invalidation";

import { ok } from "../../../utils/api-response";
import { NotFoundError, ValidationError } from "../../../utils/api-error";
import { successEnvelope, messageResponse, errorResponses } from "../../../schemas/responses";
const app = new OpenAPIHono<{ Bindings: Env }>();
const MASKED = "••••••••••••";
const CHECKOUT_CACHE_GROUPS = ["checkout"] as const;
const LAYOUT_CACHE_GROUPS = ["layout"] as const;

// ─────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────

const authSettingsResponseSchema = z.object({
    authVerificationMethod: z.string(),
    guestCheckoutEnabled: z.boolean(),
    whatsappAccessToken: z.string(),
    whatsappPhoneNumberId: z.string(),
    whatsappTemplateName: z.string(),
    checkoutMode: z.string(),
    partialPaymentEnabled: z.boolean(),
    partialPaymentAmount: z.number().nullable(),
});

const getAuthRoute = createRoute({
    method: "get",
    path: "/auth",
    tags: ["Admin - Settings"],
    summary: "Get auth/checkout settings",
    responses: {
        200: { description: "Auth settings", content: { "application/json": { schema: successEnvelope(authSettingsResponseSchema) } } },
        ...errorResponses,
    }
});

app.openapi(getAuthRoute, async (c) => {
    const db = c.get("db");
        const [row] = await db.select().from(siteSettings).limit(1);
        if (!row) throw new NotFoundError("Settings not found");

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
});

const saveAuthSchema = z.object({
    authVerificationMethod: z.enum(["email", "phone", "both", "whatsapp_otp", "sms_otp"]).optional(),
    guestCheckoutEnabled: z.boolean().optional(),
    whatsappAccessToken: z.string().optional(),
    whatsappPhoneNumberId: z.string().nullable().optional(),
    whatsappTemplateName: z.string().nullable().optional(),
    checkoutMode: z.enum(["guest_cod_only", "gateways_only", "all"]).optional(),
    partialPaymentEnabled: z.boolean().optional(),
    partialPaymentAmount: z.number().optional(),
});

const saveAuthRoute = createRoute({
    method: "post",
    path: "/auth",
    tags: ["Admin - Settings"],
    summary: "Save auth/checkout settings",
    request: { body: { content: { "application/json": { schema: saveAuthSchema } } } },
    responses: {
        200: { description: "Auth settings saved", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
    }
});

app.openapi(saveAuthRoute, async (c) => {
    const db = c.get("db");
        const body = c.req.valid("json");
        const [existingSettings] = await db.select().from(siteSettings).limit(1);

        if (!existingSettings) throw new ValidationError("Base Site Settings must be configured first");

        const updates: Partial<typeof siteSettings.$inferInsert> = {};

        if (body.authVerificationMethod) {
            updates.authVerificationMethod = body.authVerificationMethod;
        }
        if (typeof body.guestCheckoutEnabled === "boolean") updates.guestCheckoutEnabled = body.guestCheckoutEnabled;
        if (typeof body.whatsappPhoneNumberId === "string" || body.whatsappPhoneNumberId === null) {
            updates.whatsappPhoneNumberId = body.whatsappPhoneNumberId;
        }
        if (typeof body.whatsappTemplateName === "string" || body.whatsappTemplateName === null) {
            updates.whatsappTemplateName = body.whatsappTemplateName;
        }
        if (body.checkoutMode) {
            updates.checkoutMode = body.checkoutMode;
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
        await invalidateApiAndStorefrontGroups(CHECKOUT_CACHE_GROUPS, c.env);
        return ok(c, { message: "Auth settings saved successfully" });
});

// ─────────────────────────────────────────
// SECURITY
// ─────────────────────────────────────────

const getSecurityRoute = createRoute({
    method: "get",
    path: "/security",
    tags: ["Admin - Settings"],
    summary: "Get security settings",
    responses: {
        200: { description: "Security settings", content: { "application/json": { schema: successEnvelope(z.object({ cspAllowedDomains: z.string() })) } } },
        ...errorResponses,
    }
});

app.openapi(getSecurityRoute, async (c) => {
    const db = c.get("db");
        const row = await db
            .select({ value: settings.value })
            .from(settings)
            .where(and(eq(settings.key, "csp_allowed_domains"), eq(settings.category, "security")))
            .get();

        return ok(c, { cspAllowedDomains: row?.value || "" });
});

const saveSecuritySchema = z.object({
    cspAllowedDomains: z.string().optional(),
});

const saveSecurityRoute = createRoute({
    method: "post",
    path: "/security",
    tags: ["Admin - Settings"],
    summary: "Save security settings",
    request: { body: { content: { "application/json": { schema: saveSecuritySchema } } } },
    responses: {
        200: { description: "Security settings saved", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
    }
});

app.openapi(saveSecurityRoute, async (c) => {
    const db = c.get("db");
    const { cspAllowedDomains } = c.req.valid("json");

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
                    set: { value: cspAllowedDomains, updatedAt: sql`(unixepoch())` }
                });

            const env = c.env as Env | undefined;
            if (env?.CACHE) {
                c.executionCtx.waitUntil(env.CACHE.put("security:csp_allowed_domains", cspAllowedDomains));
            }
            await invalidateApiAndStorefrontGroups(LAYOUT_CACHE_GROUPS, c.env);
        }

        return ok(c, { message: "Security settings saved successfully" });
});

// ─────────────────────────────────────────
// EMAIL
// ─────────────────────────────────────────

const getEmailRoute = createRoute({
    method: "get",
    path: "/email",
    tags: ["Admin - Settings"],
    summary: "Get email settings (system)",
    responses: {
        200: { description: "Email settings", content: { "application/json": { schema: successEnvelope(z.object({ apiKey: z.string(), sender: z.string() })) } } },
        ...errorResponses,
    }
});

app.openapi(getEmailRoute, async (c) => {
    const db = c.get("db");
        const [apiKeyRow, senderRow] = await Promise.all([
            db.select({ value: settings.value }).from(settings).where(and(eq(settings.key, "resend_api_key"), eq(settings.category, "email"))).get(),
            db.select({ value: settings.value }).from(settings).where(and(eq(settings.key, "email_sender"), eq(settings.category, "email"))).get(),
        ]);

        return ok(c, {
            apiKey: apiKeyRow?.value ? MASKED : "",
            sender: senderRow?.value || ""
        });
});

const saveEmailSchema = z.object({
    apiKey: z.string().optional(),
    sender: z.string().optional(),
});

const saveEmailRoute = createRoute({
    method: "post",
    path: "/email",
    tags: ["Admin - Settings"],
    summary: "Save email settings (system)",
    request: { body: { content: { "application/json": { schema: saveEmailSchema } } } },
    responses: {
        200: { description: "Email settings saved", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
    }
});

app.openapi(saveEmailRoute, async (c) => {
    const db = c.get("db");
        const { apiKey, sender } = c.req.valid("json");
        const updates: Promise<unknown>[] = [];

        if (typeof apiKey === "string" && apiKey !== MASKED) {
            const encKey = getEncryptionKey(c.env as Record<string, unknown>);
            updates.push(upsertEncryptedSetting(db, "email", "resend_api_key", apiKey, encKey));
        }

        if (typeof sender === "string") {
            updates.push(
                db.insert(settings)
                    .values({ id: `set_${nanoid(10)}`, key: "email_sender", value: sender, type: "string", category: "email" })
                    .onConflictDoUpdate({ target: [settings.key, settings.category], set: { value: sender, updatedAt: sql`(unixepoch())` } })
            );
        }

        await Promise.all(updates);
        return ok(c, { message: "Email settings saved successfully" });
});

// ─────────────────────────────────────────
// FIREBASE
// ─────────────────────────────────────────

const getFirebaseRoute = createRoute({
    method: "get",
    path: "/firebase",
    tags: ["Admin - Settings"],
    summary: "Get Firebase settings (system)",
    responses: {
        200: { description: "Firebase settings", content: { "application/json": { schema: successEnvelope(z.object({ serviceAccount: z.string(), publicConfig: z.record(z.string(), z.unknown()) })) } } },
        ...errorResponses,
    }
});

app.openapi(getFirebaseRoute, async (c) => {
    const db = c.get("db");
        const results = await db.select({ key: settings.key, value: settings.value }).from(settings).where(eq(settings.category, "firebase")).all();

        const config: { serviceAccount: string; publicConfig: Record<string, unknown> } = { serviceAccount: "", publicConfig: {} };

        results.forEach((row) => {
            if (row.key === "service_account") config.serviceAccount = row.value ? MASKED : "";
            if (row.key === "public_config") {
                try { config.publicConfig = JSON.parse(row.value); } catch { config.publicConfig = {}; }
            }
        });

        return ok(c, config);
});

const saveFirebaseSchema = z.object({
    serviceAccount: z.string().optional(),
    publicConfig: z.record(z.string(), z.unknown()).optional(),
});

const saveFirebaseRoute = createRoute({
    method: "post",
    path: "/firebase",
    tags: ["Admin - Settings"],
    summary: "Save Firebase settings (system)",
    request: { body: { content: { "application/json": { schema: saveFirebaseSchema } } } },
    responses: {
        200: { description: "Firebase settings saved", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
    }
});

app.openapi(saveFirebaseRoute, async (c) => {
    const db = c.get("db");
    const { serviceAccount, publicConfig } = c.req.valid("json");
        const updates: Promise<unknown>[] = [];

        if (serviceAccount && serviceAccount !== MASKED) {
            try {
                JSON.parse(serviceAccount);
                updates.push(
                    db.insert(settings)
                        .values({ id: `set_${nanoid(10)}`, key: "service_account", value: serviceAccount, type: "json", category: "firebase" })
                        .onConflictDoUpdate({ target: [settings.key, settings.category], set: { value: serviceAccount, updatedAt: sql`(unixepoch())` } })
                );
            } catch {
                throw new ValidationError("Invalid Service Account JSON");
            }
        }

        if (publicConfig) {
            updates.push(
                db.insert(settings)
                    .values({ id: `set_${nanoid(10)}`, key: "public_config", value: JSON.stringify(publicConfig), type: "json", category: "firebase" })
                    .onConflictDoUpdate({ target: [settings.key, settings.category], set: { value: JSON.stringify(publicConfig), updatedAt: sql`(unixepoch())` } })
            );
        }

        await Promise.all(updates);

        const { layoutCache, CACHE_KEYS } = await import("@scalius/shared/layout-cache");
        layoutCache.invalidate(CACHE_KEYS.FIREBASE_CONFIG);

        return ok(c, { message: "Settings saved successfully" });
});

export { app as systemSettingsRoutes };
