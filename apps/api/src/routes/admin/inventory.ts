// src/server/routes/admin/inventory.ts
// Admin OpenAPI routes for inventory.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { InventoryService, adjustInventorySchema } from "@scalius/core/modules/inventory";
import { acknowledgeLowStockAlert } from "@scalius/core/modules/inventory/alerts";
import { NotFoundError, ValidationError } from "../../utils/api-error";

const app = new OpenAPIHono();

// ── List Inventory ──

const listRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Inventory"],
    summary: "Get inventory overview",
    request: {
        query: z.object({
            section: z.string().optional().default("variants").openapi({ description: "Section type" }),
            search: z.string().optional().default("").openapi({ description: "Search term" }),
            status: z.string().optional().default("all").openapi({ description: "Status filter" }),
            page: z.coerce.number().default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().default(50).openapi({ description: "Items per page" }),
            alertStatus: z.string().optional().openapi({ description: "Alert status filter" })
        })
    },
    responses: {
        200: { description: "Inventory overview"  }
    }
});

app.openapi(listRoute, async (c) => {
    const db = c.get("db");
    const query = c.req.valid("query");
    try {
        const result = await InventoryService.getInventoryOverview(db, {
            section: query.section,
            search: query.search,
            status: query.status,
            page: query.page,
            limit: query.limit,
            alertStatus: query.alertStatus
        });
        return c.json(result, 200);
    } catch (error: any) {
        if (error.message === "Invalid section parameter") {
            throw new ValidationError(error.message);
        }
        throw error;
    }
});

// ── Get Alerts ──

const alertsRoute = createRoute({
    method: "get",
    path: "/alerts",
    tags: ["Admin - Inventory"],
    summary: "Get inventory alerts",
    request: {
        query: z.object({
            status: z.string().optional().default("active").openapi({ description: "Alert status" })
        })
    },
    responses: {
        200: { description: "Inventory alerts"  }
    }
});

app.openapi(alertsRoute, async (c) => {
    const db = c.get("db");
    const { status } = c.req.valid("query");
    const result = await InventoryService.getInventoryOverview(db, {
        section: "alerts",
        search: "",
        status: "all",
        page: 1,
        limit: 50,
        alertStatus: status
    });
    return c.json(result, 200);
});

// ── Acknowledge Alert ──

const acknowledgeAlertRoute = createRoute({
    method: "patch",
    path: "/alerts",
    tags: ["Admin - Inventory"],
    summary: "Acknowledge a low stock alert",
    request: {
        body: {
            content: {
                "application/json": {
                    schema: z.object({
                        variantId: z.string().openapi({ description: "Variant ID" })
                    })
                }
            }
        }
    },
    responses: {
        200: { description: "Alert acknowledged"  }
    }
});

app.openapi(acknowledgeAlertRoute, async (c) => {
    const db = c.get("db");
    const { variantId } = c.req.valid("json");
    await acknowledgeLowStockAlert(db, variantId);
    return c.json({ success: true }, 200);
});

// ── Adjust Inventory ──

const adjustRoute = createRoute({
    method: "post",
    path: "/{variantId}/adjust",
    tags: ["Admin - Inventory"],
    summary: "Adjust inventory for a variant",
    request: {
        
        body: { content: { "application/json": { schema: adjustInventorySchema } } }
    },
    responses: {
        200: { description: "Inventory adjusted"  }
    }
});

app.openapi(adjustRoute, async (c) => {
    const db = c.get("db");
    const { variantId } = c.req.valid("param");
    const payload = c.req.valid("json");
    const user = c.get("user" as any);
    try {
        const result = await InventoryService.adjustInventory(db, variantId, payload, user?.id);
        return c.json(result, 200);
    } catch (error: any) {
        if (error.message === "Variant not found") throw new NotFoundError(error.message);
        throw error;
    }
});

export { app as adminInventoryRoutes };
