// src/server/routes/admin/navigation.ts
// Admin OpenAPI routes for navigation.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { NavigationService } from "@scalius/core/modules/navigation";
import { siteSettings } from "@scalius/database/schema";
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { invalidateSiteSettingsCache } from "@scalius/core/modules/settings";
import { getKv } from "../../utils/kv-cache";

import { ok, noContent } from "../../utils/api-response";
import { NotFoundError, ValidationError } from "../../utils/api-error";
const app = new OpenAPIHono();

// ── List Navigation Items ──

const listItemsRoute = createRoute({
    method: "get",
    path: "/items",
    tags: ["Admin - Navigation"],
    summary: "Get navigation items",
    responses: {
        200: { description: "Navigation items list"  }
    }
});

app.openapi(listItemsRoute, async (c) => {
    const db = c.get("db");
    const items = await NavigationService.getNavigationItems(db);
    return ok(c, { items });
});

// ── Get Navigation Config ──

const getConfigRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Navigation"],
    summary: "Get header and footer navigation config",
    responses: {
        200: { description: "Navigation configuration" }
    }
});

app.openapi(getConfigRoute, async (c) => {
    const db = c.get("db");
    const [row] = await db
        .select({ headerConfig: siteSettings.headerConfig, footerConfig: siteSettings.footerConfig })
        .from(siteSettings)
        .limit(1);

    const headerConfig = row?.headerConfig ? JSON.parse(row.headerConfig) : {};
    const footerConfig = row?.footerConfig ? JSON.parse(row.footerConfig) : {};

    return ok(c, { headerConfig, footerConfig });
});

// ── Save Navigation Config (Create/Update) ──

const navigationItemSchema: z.ZodType<unknown> = z.object({
    id: z.string(),
    title: z.string(),
    href: z.string().optional(),
    subMenu: z.any().optional(),
});

const saveConfigSchema = z.object({
    type: z.enum(["header", "footer"]),
    config: z.record(z.string(), z.any()),
});

const saveConfigRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["Admin - Navigation"],
    summary: "Save navigation config (header or footer)",
    request: {
        body: { content: { "application/json": { schema: saveConfigSchema } } }
    },
    responses: {
        200: { description: "Navigation config saved" }
    }
});

app.openapi(saveConfigRoute, async (c) => {
    const db = c.get("db");
    const { type, config } = c.req.valid("json");
    const configField = type === "header" ? "headerConfig" : "footerConfig";
    const configJson = JSON.stringify(config);

    const [existing] = await db.select().from(siteSettings).limit(1);

    if (existing) {
        await db
            .update(siteSettings)
            .set({ [configField]: configJson, updatedAt: sql`unixepoch()` })
            .where(eq(siteSettings.id, existing.id));
    } else {
        await db.insert(siteSettings).values({
            id: "settings_" + nanoid(),
            siteName: "My Store",
            siteDescription: "",
            headerConfig: type === "header" ? configJson : JSON.stringify({}),
            footerConfig: type === "footer" ? configJson : JSON.stringify({}),
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        });
    }

    await invalidateSiteSettingsCache(getKv());
    return ok(c, { message: `${type} navigation config saved` });
});

// ── Update Navigation Config ──

const updateConfigRoute = createRoute({
    method: "put",
    path: "/{id}",
    tags: ["Admin - Navigation"],
    summary: "Update navigation config by site settings ID",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: saveConfigSchema } } }
    },
    responses: {
        200: { description: "Navigation config updated" },
        404: { description: "Settings not found" }
    }
});

app.openapi(updateConfigRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const { type, config } = c.req.valid("json");

    const [existing] = await db.select().from(siteSettings).where(eq(siteSettings.id, id));
    if (!existing) throw new NotFoundError("Navigation settings not found");

    const configField = type === "header" ? "headerConfig" : "footerConfig";
    await db
        .update(siteSettings)
        .set({ [configField]: JSON.stringify(config), updatedAt: sql`unixepoch()` })
        .where(eq(siteSettings.id, id));

    await invalidateSiteSettingsCache(getKv());
    return ok(c, { message: `${type} navigation config updated` });
});

// ── Delete Navigation Config ──

const deleteConfigRoute = createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Admin - Navigation"],
    summary: "Reset navigation config to empty",
    request: {
        params: z.object({ id: z.string() }),
        body: {
            content: {
                "application/json": {
                    schema: z.object({
                        type: z.enum(["header", "footer"]),
                    })
                }
            }
        }
    },
    responses: {
        204: { description: "Navigation config reset" },
        404: { description: "Settings not found" }
    }
});

app.openapi(deleteConfigRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const { type } = c.req.valid("json");

    const [existing] = await db.select().from(siteSettings).where(eq(siteSettings.id, id));
    if (!existing) throw new NotFoundError("Navigation settings not found");

    const configField = type === "header" ? "headerConfig" : "footerConfig";
    await db
        .update(siteSettings)
        .set({ [configField]: JSON.stringify({}), updatedAt: sql`unixepoch()` })
        .where(eq(siteSettings.id, id));

    await invalidateSiteSettingsCache(getKv());
    return noContent(c);
});

export { app as adminNavigationRoutes };
