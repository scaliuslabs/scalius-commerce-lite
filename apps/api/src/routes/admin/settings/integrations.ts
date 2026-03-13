import { Hono } from "hono";
import { db } from "@scalius/database/client";
import { settings } from "@scalius/database/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { layoutCache, CACHE_KEYS } from "@scalius/shared/layout-cache";

const app = new Hono<{ Bindings: any, Variables: any }>();
const MASKED_VALUE = "••••••••••••";

// ─────────────────────────────────────────
// OPENROUTER
// ─────────────────────────────────────────
app.get("/openrouter", async (c) => {
    try {
        const result = await db
            .select({ value: settings.value })
            .from(settings)
            .where(and(eq(settings.key, "openrouter_api_key"), eq(settings.category, "integrations")))
            .get();

        const maskedApiKey = result?.value ? MASKED_VALUE : "";
        return c.json({ apiKey: maskedApiKey });
    } catch (error) {
        return c.json({ message: "Error fetching API key" }, 500);
    }
});

app.post("/openrouter", async (c) => {
    try {
        const { apiKey } = await c.req.json();
        if (typeof apiKey !== "string") return c.json({ message: "Invalid API key" }, 400);
        if (apiKey === MASKED_VALUE) return c.json({ message: "API key unchanged" });

        await db
            .insert(settings)
            .values({
                id: `set_${nanoid(10)}`,
                key: "openrouter_api_key",
                value: apiKey,
                type: "string",
                category: "integrations",
            })
            .onConflictDoUpdate({
                target: [settings.key, settings.category],
                set: { value: apiKey },
            });

        return c.json({ message: "API key saved successfully" });
    } catch (error) {
        return c.json({ message: "Error saving API key" }, 500);
    }
});

// ─────────────────────────────────────────
// EMAIL (RESEND)
// ─────────────────────────────────────────
app.get("/email", async (c) => {
    try {
        const [apiKeyRow, senderRow] = await Promise.all([
            db.select({ value: settings.value }).from(settings).where(and(eq(settings.key, "resend_api_key"), eq(settings.category, "email"))).get(),
            db.select({ value: settings.value }).from(settings).where(and(eq(settings.key, "email_sender"), eq(settings.category, "email"))).get(),
        ]);

        return c.json({
            apiKey: apiKeyRow?.value ? MASKED_VALUE : "",
            sender: senderRow?.value || "",
        });
    } catch (error) {
        return c.json({ message: "Error fetching email settings" }, 500);
    }
});

app.post("/email", async (c) => {
    try {
        const { apiKey, sender } = await c.req.json();
        const updates: Promise<any>[] = [];

        if (typeof apiKey === "string" && apiKey !== MASKED_VALUE) {
            updates.push(
                db.insert(settings).values({
                    id: `set_${nanoid(10)}`,
                    key: "resend_api_key",
                    value: apiKey,
                    type: "string",
                    category: "email",
                }).onConflictDoUpdate({
                    target: [settings.key, settings.category],
                    set: { value: apiKey },
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
                    category: "email",
                }).onConflictDoUpdate({
                    target: [settings.key, settings.category],
                    set: { value: sender },
                })
            );
        }

        await Promise.all(updates);
        return c.json({ message: "Email settings saved successfully" });
    } catch (error) {
        return c.json({ message: "Error saving email settings" }, 500);
    }
});

// ─────────────────────────────────────────
// FIREBASE
// ─────────────────────────────────────────
app.get("/firebase", async (c) => {
    try {
        const results = await db
            .select({ key: settings.key, value: settings.value })
            .from(settings)
            .where(eq(settings.category, "firebase"));

        const config: any = { serviceAccount: "", publicConfig: {} };

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

        return c.json(config);
    } catch (error) {
        return c.json({ error: "Internal Server Error" }, 500);
    }
});

app.post("/firebase", async (c) => {
    try {
        const { serviceAccount, publicConfig } = await c.req.json();
        const updates = [];

        if (serviceAccount && serviceAccount !== MASKED_VALUE) {
            try {
                JSON.parse(serviceAccount);
                updates.push({ key: "service_account", value: serviceAccount });
            } catch {
                return c.json({ error: "Invalid Service Account JSON" }, 400);
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
                    category: "firebase",
                })
                .onConflictDoUpdate({
                    target: [settings.key, settings.category],
                    set: { value: update.value, updatedAt: new Date() },
                });
        }

        layoutCache.invalidate(CACHE_KEYS.FIREBASE_CONFIG);
        return c.json({ message: "Settings saved successfully" });
    } catch (error) {
        return c.json({ error: "Internal Server Error" }, 500);
    }
});

export { app as integrationSettingsRoutes };
