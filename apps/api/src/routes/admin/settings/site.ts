import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getKv, deleteCacheByPattern } from "../../../utils/kv-cache";
import { invalidateSiteSettingsCache } from "@scalius/core/modules/settings";
import { layoutCache, CACHE_KEYS } from "@scalius/shared/layout-cache";
import {
    getCurrencySettings,
    saveCurrencySettings,
    getGeneralSettings,
    saveHeaderConfig,
    saveFooterConfig,
    getThemeSettings,
    saveThemeSettings,
    getSeoSettings,
    saveSeoSettings,
    getStorefrontUrlSetting,
    saveStorefrontUrl,
    getAllowedCountries,
    saveAllowedCountries,
} from "@scalius/core/modules/settings/site-settings.service";

import { ok } from "../../../utils/api-response";
import { successEnvelope, messageResponse, errorResponses } from "../../../schemas/responses";
const app = new OpenAPIHono<{ Bindings: Env }>();

// ─────────────────────────────────────────
// CURRENCY
// ─────────────────────────────────────────

const currencySettingsSchema = z.object({
    currencyCode: z.string(),
    currencySymbol: z.string(),
    usdExchangeRate: z.string(),
});

const getCurrencyRoute = createRoute({
    method: "get",
    path: "/currency",
    tags: ["Admin - Settings"],
    summary: "Get currency settings",
    responses: {
        200: { description: "Currency settings", content: { "application/json": { schema: successEnvelope(currencySettingsSchema) } } },
        ...errorResponses,
    }
});

app.openapi(getCurrencyRoute, async (c) => {
    const db = c.get("db");
    const result = await getCurrencySettings(db);
    return ok(c, result);
});

const saveCurrencySchema = z.object({
    currencyCode: z.string().optional(),
    currencySymbol: z.string().optional(),
    usdExchangeRate: z.string().optional(),
});

const saveCurrencyRoute = createRoute({
    method: "post",
    path: "/currency",
    tags: ["Admin - Settings"],
    summary: "Save currency settings",
    request: { body: { content: { "application/json": { schema: saveCurrencySchema } } } },
    responses: {
        200: { description: "Settings saved", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
    }
});

app.openapi(saveCurrencyRoute, async (c) => {
    const db = c.get("db");
    const body = c.req.valid("json");
    await saveCurrencySettings(db, body);

    const kv = getKv();
    await kv?.delete("gw:currency");

    return ok(c, { message: "Currency settings saved successfully" });
});

// ─────────────────────────────────────────
// GENERAL (header + footer config)
// ─────────────────────────────────────────

const getGeneralRoute = createRoute({
    method: "get",
    path: "/general",
    tags: ["Admin - Settings"],
    summary: "Get general settings (header + footer config)",
    responses: {
        200: { description: "General settings", content: { "application/json": { schema: successEnvelope(z.object({ headerConfig: z.record(z.string(), z.unknown()), footerConfig: z.record(z.string(), z.unknown()) })) } } },
        ...errorResponses,
    }
});

app.openapi(getGeneralRoute, async (c) => {
    try {
        const db = c.get("db");
        const result = await getGeneralSettings(db);
        return ok(c, result);
    } catch (error: unknown) {
        return ok(c, { headerConfig: {}, footerConfig: {} });
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
const navigationItemSchema: z.ZodType<unknown> = z.object({
    id: z.string(),
    title: z.string(),
    href: z.string().optional(),
    subMenu: z.array(z.record(z.string(), z.unknown())).optional().openapi({
        type: "array",
        items: {
            type: "object",
            properties: {
                id: { type: "string" },
                title: { type: "string" },
                href: { type: "string" },
                subMenu: { type: "array", items: { type: "object" } },
            },
        },
        description: "Nested navigation items",
    }),
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
    responses: {
        200: { description: "Header saved", content: { "application/json": { schema: successEnvelope(z.object({})) } } },
        ...errorResponses,
    }
});

app.openapi(saveHeaderRoute, async (c) => {
    const db = c.get("db");
    const validatedConfig = c.req.valid("json");
    await saveHeaderConfig(db, validatedConfig as unknown as Record<string, unknown>);
    await invalidateSiteSettingsCache(getKv());
    return ok(c, {});
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
    responses: {
        200: { description: "Footer saved", content: { "application/json": { schema: successEnvelope(z.object({})) } } },
        ...errorResponses,
    }
});

app.openapi(saveFooterRoute, async (c) => {
    const db = c.get("db");
    const validatedConfig = c.req.valid("json");
    await saveFooterConfig(db, validatedConfig as unknown as Record<string, unknown>);
    await invalidateSiteSettingsCache(getKv());
    return ok(c, {});
});

// ─────────────────────────────────────────
// THEME
// ─────────────────────────────────────────

const getThemeRoute = createRoute({
    method: "get",
    path: "/theme",
    tags: ["Admin - Settings"],
    summary: "Get theme settings",
    responses: {
        200: { description: "Theme settings", content: { "application/json": { schema: successEnvelope(z.object({ colors: z.record(z.string(), z.unknown()) }).passthrough()) } } },
        ...errorResponses,
    }
});

app.openapi(getThemeRoute, async (c) => {
    const db = c.get("db");
    const result = await getThemeSettings(db);
    return ok(c, result);
});

const saveThemeSchema = z.object({
    colors: z.record(z.string(), z.unknown()),
});

const saveThemeRoute = createRoute({
    method: "post",
    path: "/theme",
    tags: ["Admin - Settings"],
    summary: "Save theme settings",
    request: { body: { content: { "application/json": { schema: saveThemeSchema } } } },
    responses: {
        200: { description: "Theme saved", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
    }
});

app.openapi(saveThemeRoute, async (c) => {
    const db = c.get("db");
    const body = c.req.valid("json");
    await saveThemeSettings(db, body.colors);

    const kv = getKv();
    if (kv) {
        await deleteCacheByPattern("api:storefront:layout:*", kv);
    }
    return ok(c, { message: "Theme settings saved successfully" });
});

// ─────────────────────────────────────────
// SEO
// ─────────────────────────────────────────

const seoSettingsSchema = z.object({
    siteTitle: z.string(),
    homepageTitle: z.string(),
    homepageMetaDescription: z.string(),
    robotsTxt: z.string(),
});

const getSeoRoute = createRoute({
    method: "get",
    path: "/seo",
    tags: ["Admin - Settings"],
    summary: "Get SEO settings",
    responses: {
        200: { description: "SEO settings", content: { "application/json": { schema: successEnvelope(seoSettingsSchema) } } },
        ...errorResponses,
    }
});

app.openapi(getSeoRoute, async (c) => {
    try {
        const db = c.get("db");
        const result = await getSeoSettings(db);
        return ok(c, result);
    } catch (error: unknown) {
        return ok(c, { siteTitle: "", homepageTitle: "", homepageMetaDescription: "", robotsTxt: "" });
    }
});

const saveSeoSchema = z.object({
    siteTitle: z.string().optional(),
    homepageTitle: z.string().optional(),
    homepageMetaDescription: z.string().optional(),
    robotsTxt: z.string().optional(),
});

const saveSeoRoute = createRoute({
    method: "post",
    path: "/seo",
    tags: ["Admin - Settings"],
    summary: "Save SEO settings",
    request: { body: { content: { "application/json": { schema: saveSeoSchema } } } },
    responses: {
        200: { description: "SEO saved", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
    }
});

app.openapi(saveSeoRoute, async (c) => {
    const db = c.get("db");
    const data = c.req.valid("json");
    await saveSeoSettings(db, data);
    await invalidateSiteSettingsCache(getKv());
    return ok(c, { message: "SEO settings saved successfully" });
});

// ─────────────────────────────────────────
// STOREFRONT URL
// ─────────────────────────────────────────

const getStorefrontUrlRoute = createRoute({
    method: "get",
    path: "/storefront-url",
    tags: ["Admin - Settings"],
    summary: "Get storefront URL",
    responses: {
        200: { description: "Storefront URL", content: { "application/json": { schema: successEnvelope(z.object({ storefrontUrl: z.string() })) } } },
        ...errorResponses,
    }
});

app.openapi(getStorefrontUrlRoute, async (c) => {
    try {
        const db = c.get("db");
        const result = await getStorefrontUrlSetting(db);
        return ok(c, result);
    } catch (error: unknown) {
        return ok(c, { storefrontUrl: "/" });
    }
});

const saveStorefrontUrlSchema = z.object({
    storefrontUrl: z.string().optional(),
});

const saveStorefrontUrlRoute = createRoute({
    method: "post",
    path: "/storefront-url",
    tags: ["Admin - Settings"],
    summary: "Save storefront URL",
    request: { body: { content: { "application/json": { schema: saveStorefrontUrlSchema } } } },
    responses: {
        200: { description: "URL saved", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
    }
});

app.openapi(saveStorefrontUrlRoute, async (c) => {
    const db = c.get("db");
    const { storefrontUrl } = c.req.valid("json");
    await saveStorefrontUrl(db, storefrontUrl);
    layoutCache.invalidate(CACHE_KEYS.STOREFRONT_URL);
    await invalidateSiteSettingsCache(getKv());
    return ok(c, { message: "Storefront URL saved successfully" });
});

// ── Allowed Countries ──

const getAllowedCountriesRoute = createRoute({
    method: "get",
    path: "/allowed-countries",
    tags: ["Admin - Settings"],
    summary: "Get allowed countries for phone numbers",
    responses: {
        200: { description: "Allowed countries list", content: { "application/json": { schema: successEnvelope(z.object({ allowedCountries: z.array(z.string()), allowedCountriesMode: z.string() }).passthrough()) } } },
        ...errorResponses,
    }
});

app.openapi(getAllowedCountriesRoute, async (c) => {
    const db = c.get("db");
    const result = await getAllowedCountries(db);
    return ok(c, result);
});

const saveAllowedCountriesRoute = createRoute({
    method: "put",
    path: "/allowed-countries",
    tags: ["Admin - Settings"],
    summary: "Save allowed countries for phone numbers",
    request: {
        body: {
            content: {
                "application/json": {
                    schema: z.object({
                        allowedCountries: z.array(z.string()),
                        mode: z.enum(["include", "exclude"]).optional().default("include"),
                    })
                }
            }
        }
    },
    responses: {
        200: { description: "Countries saved", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
    }
});

app.openapi(saveAllowedCountriesRoute, async (c) => {
    const db = c.get("db");
    const { allowedCountries, mode } = c.req.valid("json");
    const result = await saveAllowedCountries(db, allowedCountries, mode || "include");
    return ok(c, { message: "Allowed countries saved", ...result });
});

export { app as siteSettingsRoutes };
