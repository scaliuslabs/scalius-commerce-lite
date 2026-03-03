// src/server/routes/admin/analytics.ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { AnalyticsService, createAnalyticsSchema, updateAnalyticsSchema, toggleAnalyticsSchema } from "@/modules/analytics";

const app = new Hono<{ Bindings: any }>();

app.get("/", async (c) => {
    try {
        const db = c.get("db");
        const scripts = await AnalyticsService.listScripts(db);
        return c.json(scripts, 200);
    } catch (error: any) {
        console.error("Error fetching analytics scripts:", error);
        return c.json({ error: "Internal server error" }, 500);
    }
});

app.post("/", zValidator("json", createAnalyticsSchema), async (c) => {
    try {
        const db = c.get("db");
        const data = c.req.valid("json");
        const result = await AnalyticsService.createScript(db, data);
        return c.json(result, 201);
    } catch (error: any) {
        console.error("Error creating analytics script:", error);
        return c.json({ error: "Internal server error" }, 500);
    }
});

app.get("/:id", async (c) => {
    try {
        const db = c.get("db");
        const id = c.req.param("id");
        const script = await AnalyticsService.getScript(db, id);
        if (!script) {
            return c.json({ error: "Analytics script not found" }, 404);
        }
        return c.json(script, 200);
    } catch (error: any) {
        console.error("Error fetching analytics script:", error);
        return c.json({ error: "Internal server error" }, 500);
    }
});

app.put("/:id", zValidator("json", updateAnalyticsSchema), async (c) => {
    try {
        const db = c.get("db");
        const id = c.req.param("id");
        const data = c.req.valid("json");

        // Validate ID match
        if (data.id && data.id !== id) {
            return c.json({ error: "ID mismatch" }, 400);
        }

        const updated = await AnalyticsService.updateScript(db, id, data);
        if (!updated) {
            return c.json({ error: "Analytics script not found" }, 404);
        }
        return c.json({ success: true, script: updated }, 200);
    } catch (error: any) {
        console.error("Error updating analytics script:", error);
        return c.json({ error: "Internal server error" }, 500);
    }
});

app.delete("/:id", async (c) => {
    try {
        const db = c.get("db");
        const id = c.req.param("id");

        const deleted = await AnalyticsService.deleteScript(db, id);
        if (!deleted) {
            return c.json({ error: "Analytics script not found" }, 404);
        }
        return c.json({ success: true, message: "Analytics script deleted", deletedScript: deleted }, 200);
    } catch (error: any) {
        console.error("Error deleting analytics script:", error);
        return c.json({ error: "Internal server error" }, 500);
    }
});

app.post("/:id/toggle", zValidator("json", toggleAnalyticsSchema), async (c) => {
    try {
        const db = c.get("db");
        const id = c.req.param("id");
        const data = c.req.valid("json");

        const toggled = await AnalyticsService.toggleScript(db, id, data.isActive);
        if (!toggled) {
            return c.json({ error: "Analytics script not found" }, 404);
        }
        return c.json({
            success: true,
            message: `Analytics script ${data.isActive ? "activated" : "deactivated"}`,
            script: toggled
        }, 200);
    } catch (error: any) {
        console.error("Error toggling analytics script status:", error);
        return c.json({ error: "Internal server error" }, 500);
    }
});

export { app as adminAnalyticsRoutes };
