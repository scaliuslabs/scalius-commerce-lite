import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { settings } from "@scalius/database/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { layoutCache, CACHE_KEYS } from "@scalius/shared/layout-cache";

import { ok } from "../../../utils/api-response";
import { ValidationError } from "../../../utils/api-error";
const app = new OpenAPIHono();
const MASKED_VALUE = "••••••••••••";

// ─────────────────────────────────────────
// OPENROUTER
// ─────────────────────────────────────────

const getOpenRouterRoute = createRoute({
    method: "get",
    path: "/openrouter",
    tags: ["Admin - Settings"],
    summary: "Get OpenRouter API key status",
    responses: { 200: { description: "API key status"  } }
});

app.openapi(getOpenRouterRoute, async (c) => {
    try {
        const db = c.get("db");
        const result = await db
            .select({ value: settings.value })
            .from(settings)
            .where(and(eq(settings.key, "openrouter_api_key"), eq(settings.category, "integrations")))
            .get();

        const maskedApiKey = result?.value ? MASKED_VALUE : "";
        return ok(c, { apiKey: maskedApiKey });
    } catch (error: unknown) {
        throw error;
    }
});

const saveOpenRouterSchema = z.object({
    apiKey: z.string(),
});

const saveOpenRouterRoute = createRoute({
    method: "post",
    path: "/openrouter",
    tags: ["Admin - Settings"],
    summary: "Save OpenRouter API key",
    request: { body: { content: { "application/json": { schema: saveOpenRouterSchema } } } },
    responses: { 200: { description: "API key saved"  } }
});

app.openapi(saveOpenRouterRoute, async (c) => {
    try {
        const db = c.get("db");
        const { apiKey } = c.req.valid("json");
        if (apiKey === MASKED_VALUE) return ok(c, { message: "API key unchanged" });

        await db
            .insert(settings)
            .values({
                id: `set_${nanoid(10)}`,
                key: "openrouter_api_key",
                value: apiKey,
                type: "string",
                category: "integrations"
            })
            .onConflictDoUpdate({
                target: [settings.key, settings.category],
                set: { value: apiKey }
            });

        return ok(c, { message: "API key saved successfully" });
    } catch (error: unknown) {
        throw error;
    }
});

// ─────────────────────────────────────────
// EMAIL (RESEND)
// ─────────────────────────────────────────

const getEmailRoute = createRoute({
    method: "get",
    path: "/email",
    tags: ["Admin - Settings"],
    summary: "Get email settings",
    responses: { 200: { description: "Email settings"  } }
});

app.openapi(getEmailRoute, async (c) => {
    try {
        const db = c.get("db");
        const [apiKeyRow, senderRow] = await Promise.all([
            db.select({ value: settings.value }).from(settings).where(and(eq(settings.key, "resend_api_key"), eq(settings.category, "email"))).get(),
            db.select({ value: settings.value }).from(settings).where(and(eq(settings.key, "email_sender"), eq(settings.category, "email"))).get(),
        ]);

        return ok(c, {
            apiKey: apiKeyRow?.value ? MASKED_VALUE : "",
            sender: senderRow?.value || ""
        });
    } catch (error: unknown) {
        throw error;
    }
});

const saveEmailSchema = z.object({
    apiKey: z.string().optional(),
    sender: z.string().optional(),
});

const saveEmailRoute = createRoute({
    method: "post",
    path: "/email",
    tags: ["Admin - Settings"],
    summary: "Save email settings",
    request: { body: { content: { "application/json": { schema: saveEmailSchema } } } },
    responses: { 200: { description: "Email settings saved"  } }
});

app.openapi(saveEmailRoute, async (c) => {
    try {
        const db = c.get("db");
        const { apiKey, sender } = c.req.valid("json");
        const updates: Promise<unknown>[] = [];

        if (typeof apiKey === "string" && apiKey !== MASKED_VALUE) {
            updates.push(
                db.insert(settings).values({
                    id: `set_${nanoid(10)}`,
                    key: "resend_api_key",
                    value: apiKey,
                    type: "string",
                    category: "email"
                }).onConflictDoUpdate({
                    target: [settings.key, settings.category],
                    set: { value: apiKey }
                })
            );
        }

        if (typeof sender === "string") {
            updates.push(
                db.insert(settings).values({
                    id: `set_${nanoid(10)}`,
                    key: "email_sender",
                    value: sender,
                    type: "string",
                    category: "email"
                }).onConflictDoUpdate({
                    target: [settings.key, settings.category],
                    set: { value: sender }
                })
            );
        }

        await Promise.all(updates);
        return ok(c, { message: "Email settings saved successfully" });
    } catch (error: unknown) {
        throw error;
    }
});

// ─────────────────────────────────────────
// FIREBASE
// ─────────────────────────────────────────

const getFirebaseRoute = createRoute({
    method: "get",
    path: "/firebase",
    tags: ["Admin - Settings"],
    summary: "Get Firebase settings",
    responses: { 200: { description: "Firebase settings"  } }
});

app.openapi(getFirebaseRoute, async (c) => {
    try {
        const db = c.get("db");
        const results = await db
            .select({ key: settings.key, value: settings.value })
            .from(settings)
            .where(eq(settings.category, "firebase"));

        const config: { serviceAccount: string; publicConfig: Record<string, unknown> } = { serviceAccount: "", publicConfig: {} };

        results.forEach((row) => {
            if (row.key === "service_account") {
                config.serviceAccount = row.value ? MASKED_VALUE : "";
            } else if (row.key === "public_config") {
                try {
                    config.publicConfig = JSON.parse(row.value);
                } catch {
                    config.publicConfig = {};
                }
            }
        });

        return ok(c, config);
    } catch (error: unknown) {
        throw error;
    }
});

const saveFirebaseSchema = z.object({
    serviceAccount: z.string().optional(),
    publicConfig: z.any().optional(),
});

const saveFirebaseRoute = createRoute({
    method: "post",
    path: "/firebase",
    tags: ["Admin - Settings"],
    summary: "Save Firebase settings",
    request: { body: { content: { "application/json": { schema: saveFirebaseSchema } } } },
    responses: { 200: { description: "Firebase settings saved"  } }
});

app.openapi(saveFirebaseRoute, async (c) => {
    try {
        const db = c.get("db");
        const { serviceAccount, publicConfig } = c.req.valid("json");
        const updates = [];

        if (serviceAccount && serviceAccount !== MASKED_VALUE) {
            try {
                JSON.parse(serviceAccount);
                updates.push({ key: "service_account", value: serviceAccount });
            } catch {
                throw new ValidationError("Invalid Service Account JSON");
            }
        }

        if (publicConfig) {
            updates.push({ key: "public_config", value: JSON.stringify(publicConfig) });
        }

        for (const update of updates) {
            await db
                .insert(settings)
                .values({
                    id: `set_${nanoid(10)}`,
                    key: update.key,
                    value: update.value,
                    type: "json",
                    category: "firebase"
                })
                .onConflictDoUpdate({
                    target: [settings.key, settings.category],
                    set: { value: update.value, updatedAt: new Date() }
                });
        }

        layoutCache.invalidate(CACHE_KEYS.FIREBASE_CONFIG);
        return ok(c, { message: "Settings saved successfully" });
    } catch (error: unknown) {
        throw error;
    }
});

export { app as integrationSettingsRoutes };
