// src/server/routes/admin/navigation.ts
import { Hono } from "hono";
import { NavigationService } from "@/modules/navigation";

const app = new Hono<{ Bindings: any }>();

app.get("/items", async (c) => {
    const db = c.get("db");

    try {
        const items = await NavigationService.getNavigationItems(db);
        return c.json({ items });
    } catch (error: any) {
        console.error("Error fetching navigation items:", error);
        return c.json({ error: "Internal server error" }, 500);
    }
});

export { app as adminNavigationRoutes };
