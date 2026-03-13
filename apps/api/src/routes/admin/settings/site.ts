import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { db } from "@scalius/database/client";
import { settings, siteSettings } from "@scalius/database/schema";
import { eq, and, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getKv, deleteCacheByPattern } from "../../../utils/kv-cache";
import { upsertSetting } from "@scalius/core/modules/payments/gateway-settings";
import { layoutCache, CACHE_KEYS } from "@scalius/shared/layout-cache";

const app = new OpenAPIHono();

// ─────────────────────────────────────────
// CURRENCY
// ─────────────────────────────────────────

const getCurrencyRoute = createRoute({
    method: "get",
    path: "/currency",
    tags: ["Admin - Settings"],
    summary: "Get currency settings",
    responses: { 200: { description: "Currency settings"  } }
});

app.openapi(getCurrencyRoute, async (c) => {
    try {
        const rows = await db
            .select({ key: settings.key, value: settings.value })
            .from(settings)
            .where(eq(settings.category, "currency"))
            .all();

        const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));

        return c.json({
            currencyCode: map["currency_code"] ?? "BDT",
            currencySymbol: map["currency_symbol"] ?? "\u09F3",
            usdExchangeRate: map["usd_exchange_rate"] ?? "1"
        }, 200);
    } catch (error) {
        console.error("Error fetching currency settings:", error);
        return c.json({ message: "Error fetching currency settings" }, 500);
    }
});

const saveCurrencyRoute = createRoute({
    method: "post",
    path: "/currency",
    tags: ["Admin - Settings"],
    summary: "Save currency settings",
    responses: { 200: { description: "Settings saved"  } }
});

app.openapi(saveCurrencyRoute, async (c) => {
    try {
        const body = (await c.req.json()) as any;
        const ops: Promise<void>[] = [];

        if (typeof body.currencyCode === "string" && body.currencyCode.trim()) {
            ops.push(upsertSetting(db, "currency", "currency_code", body.currencyCode.trim()));
        }
        if (typeof body.currencySymbol === "string" && body.currencySymbol.trim()) {
            ops.push(upsertSetting(db, "currency", "currency_symbol", body.currencySymbol.trim()));
        }
        if (typeof body.usdExchangeRate === "string" && body.usdExchangeRate.trim()) {
            const rate = parseFloat(body.usdExchangeRate.trim());
            if (!isNaN(rate) && rate > 0) {
                ops.push(upsertSetting(db, "currency", "usd_exchange_rate", String(rate)));
            }
        }
        await Promise.all(ops);

        const kv = getKv();
        await kv?.delete("gw:currency");

        return c.json({ message: "Currency settings saved successfully" }, 200);
    } catch (error) {
        console.error("Error saving currency settings:", error);
        return c.json({ message: "Error saving currency settings" }, 500);
    }
});

// ─────────────────────────────────────────
// HEADER
// ─────────────────────────────────────────
const socialLinkSchema = z.object({
    id: z.string(),
    label: z.string(),
    url: z.string(),
    iconUrl: z.string().optional()
});
const navigationItemSchema: z.ZodType<any> = z.object({
    id: z.string(),
    title: z.string(),
    href: z.string().optional(),
    subMenu: z.lazy(() => z.array(navigationItemSchema)).optional()
});
const headerConfigSchema = z.object({
    topBar: z.object({ text: z.string(), isEnabled: z.boolean().optional().default(true) }),
    logo: z.object({ src: z.string(), alt: z.string() }),
    favicon: z.object({ src: z.string(), alt: z.string() }),
    contact: z.object({ phone: z.string(), text: z.string(), isEnabled: z.boolean().optional().default(true) }),
    social: z.array(socialLinkSchema),
    navigation: z.array(navigationItemSchema)
});

const saveHeaderRoute = createRoute({
    method: "post",
    path: "/header",
    tags: ["Admin - Settings"],
    summary: "Save header configuration",
    request: { body: { content: { "application/json": { schema: headerConfigSchema } } } },
    responses: { 200: { description: "Header saved"  } }
});

app.openapi(saveHeaderRoute, async (c) => {
    try {
        const validatedConfig = c.req.valid("json");
        const [existingSettings] = await db.select().from(siteSettings).limit(1);

        if (existingSettings) {
            await db
                .update(siteSettings)
                .set({
                    headerConfig: JSON.stringify(validatedConfig),
                    updatedAt: sql`unixepoch()`
                })
                .where(eq(siteSettings.id, existingSettings.id));
        } else {
            await db.insert(siteSettings).values({
                id: "settings_" + nanoid(),
                siteName: "My Store",
                siteDescription: "",
                headerConfig: JSON.stringify(validatedConfig),
                footerConfig: JSON.stringify({}),
                createdAt: sql`unixepoch()`,
                updatedAt: sql`unixepoch()`
            });
        }
        return c.json({ success: true }, 200);
    } catch (error: any) {
        return c.json({ error: "Failed to save header configuration" }, 500);
    }
});

// ─────────────────────────────────────────
// FOOTER
// ─────────────────────────────────────────
const footerMenuSchema = z.object({
    id: z.string(),
    title: z.string(),
    links: z.array(navigationItemSchema)
});
const footerConfigSchema = z.object({
    logo: z.object({ src: z.string(), alt: z.string() }),
    tagline: z.string().optional().default(""),
    description: z.string().optional().default(""),
    copyrightText: z.string().optional().default(""),
    menus: z.array(footerMenuSchema),
    social: z.array(socialLinkSchema)
});

const saveFooterRoute = createRoute({
    method: "post",
    path: "/footer",
    tags: ["Admin - Settings"],
    summary: "Save footer configuration",
    request: { body: { content: { "application/json": { schema: footerConfigSchema } } } },
    responses: { 200: { description: "Footer saved"  } }
});

app.openapi(saveFooterRoute, async (c) => {
    try {
        const validatedConfig = c.req.valid("json");
        const [existingSettings] = await db.select().from(siteSettings).limit(1);

        if (existingSettings) {
            await db
                .update(siteSettings)
                .set({
                    footerConfig: JSON.stringify(validatedConfig),
                    updatedAt: sql`unixepoch()`
                })
                .where(eq(siteSettings.id, existingSettings.id));
        } else {
            await db.insert(siteSettings).values({
                id: "settings_" + nanoid(),
                siteName: "My Store",
                siteDescription: "",
                headerConfig: JSON.stringify({}),
                footerConfig: JSON.stringify(validatedConfig),
                createdAt: sql`unixepoch()`,
                updatedAt: sql`unixepoch()`
            });
        }
        return c.json({ success: true }, 200);
    } catch (error: any) {
        return c.json({ error: "Failed to save footer configuration" }, 500);
    }
});

// ─────────────────────────────────────────
// THEME
// ─────────────────────────────────────────

const getThemeRoute = createRoute({
    method: "get",
    path: "/theme",
    tags: ["Admin - Settings"],
    summary: "Get theme settings",
    responses: { 200: { description: "Theme settings"  } }
});

app.openapi(getThemeRoute, async (c) => {
    try {
        const row = await db
            .select({ value: settings.value })
            .from(settings)
            .where(and(eq(settings.category, "theme"), eq(settings.key, "storefront_colors")))
            .get();

        const colors = row?.value ? JSON.parse(row.value) : {};
        return c.json({ colors }, 200);
    } catch (error) {
        return c.json({ message: "Error fetching theme settings" }, 500);
    }
});

const saveThemeRoute = createRoute({
    method: "post",
    path: "/theme",
    tags: ["Admin - Settings"],
    summary: "Save theme settings",
    responses: { 200: { description: "Theme saved"  } }
});

app.openapi(saveThemeRoute, async (c) => {
    try {
        const body = (await c.req.json()) as any;
        if (!body.colors || typeof body.colors !== "object") return c.json({ message: "Invalid colors payload" }, 400);

        await upsertSetting(db, "theme", "storefront_colors", JSON.stringify(body.colors));
        const kv = getKv();
        if (kv) {
            await deleteCacheByPattern("api:storefront:layout:*", kv);
        }
        return c.json({ message: "Theme settings saved successfully" }, 200);
    } catch (error) {
        return c.json({ message: "Error saving theme settings" }, 500);
    }
});

// ─────────────────────────────────────────
// SEO
// ─────────────────────────────────────────

const getSeoRoute = createRoute({
    method: "get",
    path: "/seo",
    tags: ["Admin - Settings"],
    summary: "Get SEO settings",
    responses: { 200: { description: "SEO settings"  } }
});

app.openapi(getSeoRoute, async (c) => {
    try {
        const [row] = await db
            .select({
                siteTitle: siteSettings.siteTitle,
                homepageTitle: siteSettings.homepageTitle,
                homepageMetaDescription: siteSettings.homepageMetaDescription,
                robotsTxt: siteSettings.robotsTxt
            })
            .from(siteSettings)
            .limit(1);

        return c.json({
            siteTitle: row?.siteTitle || "",
            homepageTitle: row?.homepageTitle || "",
            homepageMetaDescription: row?.homepageMetaDescription || "",
            robotsTxt: row?.robotsTxt || ""
        }, 200);
    } catch (error) {
        return c.json({ siteTitle: "", homepageTitle: "", homepageMetaDescription: "", robotsTxt: "" }, 200);
    }
});

const saveSeoRoute = createRoute({
    method: "post",
    path: "/seo",
    tags: ["Admin - Settings"],
    summary: "Save SEO settings",
    responses: { 200: { description: "SEO saved"  } }
});

app.openapi(saveSeoRoute, async (c) => {
    try {
        const { siteTitle, homepageTitle, homepageMetaDescription, robotsTxt } = await c.req.json();
        const [existing] = await db.select().from(siteSettings).limit(1);

        if (existing) {
            await db
                .update(siteSettings)
                .set({
                    siteTitle,
                    homepageTitle,
                    homepageMetaDescription,
                    robotsTxt,
                    updatedAt: sql`unixepoch()`
                })
                .where(eq(siteSettings.id, existing.id));
        } else {
            await db.insert(siteSettings).values({
                id: "settings_" + nanoid(),
                siteName: "My Store",
                headerConfig: JSON.stringify({}),
                footerConfig: JSON.stringify({}),
                siteTitle,
                homepageTitle,
                homepageMetaDescription,
                robotsTxt,
                createdAt: sql`unixepoch()`,
                updatedAt: sql`unixepoch()`
            });
        }
        return c.json({ success: true, message: "SEO settings saved successfully" }, 200);
    } catch (error) {
        return c.json({ error: "Failed to save SEO configuration" }, 500);
    }
});

// ─────────────────────────────────────────
// STOREFRONT URL
// ─────────────────────────────────────────

const getStorefrontUrlRoute = createRoute({
    method: "get",
    path: "/storefront-url",
    tags: ["Admin - Settings"],
    summary: "Get storefront URL",
    responses: { 200: { description: "Storefront URL"  } }
});

app.openapi(getStorefrontUrlRoute, async (c) => {
    try {
        const [row] = await db.select({ storefrontUrl: siteSettings.storefrontUrl }).from(siteSettings).limit(1);
        return c.json({ storefrontUrl: row?.storefrontUrl || "/" }, 200);
    } catch (error) {
        return c.json({ storefrontUrl: "/" }, 200);
    }
});

const saveStorefrontUrlRoute = createRoute({
    method: "post",
    path: "/storefront-url",
    tags: ["Admin - Settings"],
    summary: "Save storefront URL",
    responses: { 200: { description: "URL saved"  } }
});

app.openapi(saveStorefrontUrlRoute, async (c) => {
    try {
        const { storefrontUrl } = await c.req.json();
        const [existing] = await db.select().from(siteSettings).limit(1);

        if (existing) {
            await db
                .update(siteSettings)
                .set({ storefrontUrl: storefrontUrl || "/", updatedAt: sql`unixepoch()` })
                .where(eq(siteSettings.id, existing.id));
        } else {
            await db.insert(siteSettings).values({
                id: "settings_" + nanoid(),
                siteName: "My Store",
                headerConfig: JSON.stringify({}),
                footerConfig: JSON.stringify({}),
                storefrontUrl: storefrontUrl || "/",
                createdAt: sql`unixepoch()`,
                updatedAt: sql`unixepoch()`
            });
        }
        layoutCache.invalidate(CACHE_KEYS.STOREFRONT_URL);
        return c.json({ success: true, message: "Storefront URL saved successfully" }, 200);
    } catch (error) {
        return c.json({ error: "Failed to save storefront URL" }, 500);
    }
});

export { app as siteSettingsRoutes };
