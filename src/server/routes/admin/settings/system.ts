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

export { app as systemSettingsRoutes };
