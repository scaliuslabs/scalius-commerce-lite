import { Hono } from "hono";
import { db } from "@/db";
import { settings, siteSettings } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";

const app = new Hono<{ Bindings: any, Variables: any }>();
const MASKED = "••••••••••••";

// ─────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────
app.get("/auth", async (c) => {
    try {
        const [row] = await db.select().from(siteSettings).limit(1);
        if (!row) return c.json({ message: "Settings not found" }, 404);

        return c.json({
            authVerificationMethod: row.authVerificationMethod,
            guestCheckoutEnabled: row.guestCheckoutEnabled,
            whatsappAccessToken: row.whatsappAccessToken ? MASKED : "",
            whatsappPhoneNumberId: row.whatsappPhoneNumberId || "",
            whatsappTemplateName: row.whatsappTemplateName || "",
            checkoutMode: row.checkoutMode,
            partialPaymentEnabled: row.partialPaymentEnabled,
            partialPaymentAmount: row.partialPaymentAmount,
        });
    } catch (error) {
        return c.json({ message: "Error fetching auth settings" }, 500);
    }
});

app.post("/auth", async (c) => {
    try {
        const body = (await c.req.json()) as any;
        const [existingSettings] = await db.select().from(siteSettings).limit(1);

        if (!existingSettings) return c.json({ message: "Base Site Settings must be configured first" }, 400);

        const updates: Partial<typeof siteSettings.$inferInsert> = {};

        if (body.authVerificationMethod) updates.authVerificationMethod = body.authVerificationMethod;
        if (body.guestCheckoutEnabled !== undefined) updates.guestCheckoutEnabled = body.guestCheckoutEnabled;
        if (body.whatsappPhoneNumberId !== undefined) updates.whatsappPhoneNumberId = body.whatsappPhoneNumberId;
        if (body.whatsappTemplateName !== undefined) updates.whatsappTemplateName = body.whatsappTemplateName;
        if (body.checkoutMode !== undefined) updates.checkoutMode = body.checkoutMode;
        if (body.partialPaymentEnabled !== undefined) updates.partialPaymentEnabled = body.partialPaymentEnabled;
        if (body.partialPaymentAmount !== undefined) updates.partialPaymentAmount = body.partialPaymentAmount;

        if (body.whatsappAccessToken && body.whatsappAccessToken !== MASKED) {
            updates.whatsappAccessToken = body.whatsappAccessToken;
        }

        await db
            .update(siteSettings)
            .set(updates)
            .where(eq(siteSettings.id, existingSettings.id));

        return c.json({ message: "Auth settings saved successfully" });
    } catch (error) {
        return c.json({ message: "Error saving auth settings" }, 500);
    }
});

// ─────────────────────────────────────────
// SECURITY
// ─────────────────────────────────────────
app.get("/security", async (c) => {
    try {
        const row = await db
            .select({ value: settings.value })
            .from(settings)
            .where(and(eq(settings.key, "csp_allowed_domains"), eq(settings.category, "security")))
            .get();

        return c.json({ cspAllowedDomains: row?.value || "" });
    } catch (error) {
        return c.json({ message: "Error fetching security settings" }, 500);
    }
});

app.post("/security", async (c) => {
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
                    category: "security",
                })
                .onConflictDoUpdate({
                    target: [settings.key, settings.category],
                    set: { value: cspAllowedDomains, updatedAt: new Date() },
                });

            // If we have access to the CACHE binding, update it
            const env = c.env as any;
            if (env?.CACHE) {
                // Background execution wrapper for Cloudflare Workers
                c.executionCtx.waitUntil(env.CACHE.put("security:csp_allowed_domains", cspAllowedDomains));
            }
        }

        return c.json({ message: "Security settings saved successfully" });
    } catch (error) {
        return c.json({ message: "Error saving security settings" }, 500);
    }
});

// ─────────────────────────────────────────
// EMAIL
// ─────────────────────────────────────────
app.get("/email", async (c) => {
    try {
        const [apiKeyRow, senderRow] = await Promise.all([
            db.select({ value: settings.value }).from(settings).where(and(eq(settings.key, "resend_api_key"), eq(settings.category, "email"))).get(),
            db.select({ value: settings.value }).from(settings).where(and(eq(settings.key, "email_sender"), eq(settings.category, "email"))).get(),
        ]);

        return c.json({
            apiKey: apiKeyRow?.value ? MASKED : "",
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
        const results = await db.select({ key: settings.key, value: settings.value }).from(settings).where(eq(settings.category, "firebase")).all();

        const config: any = { serviceAccount: "", publicConfig: {} };

        results.forEach((row) => {
            if (row.key === "service_account") config.serviceAccount = row.value ? MASKED : "";
            if (row.key === "public_config") {
                try { config.publicConfig = JSON.parse(row.value); } catch (_) { config.publicConfig = {}; }
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
        const updates: Promise<any>[] = [];

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

        // Invalidate cache
        const { layoutCache, CACHE_KEYS } = await import("@/shared/layout-cache");
        layoutCache.invalidate(CACHE_KEYS.FIREBASE_CONFIG);

        return c.json({ message: "Settings saved successfully" });
    } catch (error) {
        return c.json({ error: "Internal Server Error" }, 500);
    }
});

export { app as systemSettingsRoutes };
