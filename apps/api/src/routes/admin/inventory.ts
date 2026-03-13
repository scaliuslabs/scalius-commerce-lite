// src/server/routes/admin/inventory.ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { InventoryService, adjustInventorySchema } from "@scalius/core/modules/inventory";
import { acknowledgeLowStockAlert } from "@scalius/core/modules/inventory/alerts";

const app = new Hono<{ Bindings: any }>();

app.get("/", async (c) => {
    const db = c.get("db");
    const query = c.req.query();

    const section = query.section || "variants";
    const search = query.search || "";
    const status = query.status || "all";
    const page = parseInt(query.page || "1");
    const limit = parseInt(query.limit || "50");
    const alertStatus = query.alertStatus;

    try {
        const result = await InventoryService.getInventoryOverview(db, {
            section, search, status, page, limit, alertStatus
        });
        return c.json(result);
    } catch (error: any) {
        if (error.message === "Invalid section parameter") {
            return c.json({ error: error.message }, 400);
        }
        return c.json({ error: "Failed to fetch inventory data" }, 500);
    }
});

app.get("/alerts", async (c) => {
    const db = c.get("db");
    const status = c.req.query("status") || "active";

    try {
        const result = await InventoryService.getInventoryOverview(db, {
            section: "alerts",
            search: "",
            status: "all",
            page: 1,
            limit: 50,
            alertStatus: status
        });
        return c.json(result);
    } catch (error: any) {
        return c.json({ error: "Failed to fetch alerts" }, 500);
    }
});

app.patch("/alerts", async (c) => {
    const db = c.get("db");
    const body: any = await c.req.parseBody().catch(() => c.req.json().catch(() => ({})));

    if (!body.variantId) {
        return c.json({ error: "variantId is required" }, 400);
    }

    try {
        await acknowledgeLowStockAlert(db, body.variantId);
        return c.json({ success: true });
    } catch (error: any) {
        return c.json({ error: "Failed to acknowledge alert" }, 500);
    }
});

app.post("/:variantId/adjust", zValidator("json", adjustInventorySchema), async (c) => {
    const db = c.get("db");
    const variantId = c.req.param("variantId");
    const payload = c.req.valid("json");
    const user = c.get("user" as any); // Set by authMiddleware

    try {
        const result = await InventoryService.adjustInventory(db, variantId, payload, user?.id);
        return c.json(result);
    } catch (error: any) {
        if (error.message === "Variant not found") return c.json({ error: error.message }, 404);
        return c.json({ error: "Failed to adjust inventory" }, 500);
    }
});

export { app as adminInventoryRoutes };
