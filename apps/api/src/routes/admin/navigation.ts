// src/server/routes/admin/navigation.ts
// Admin OpenAPI routes for navigation.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { NavigationService } from "@scalius/core/modules/navigation";

const app = new OpenAPIHono();

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
    return c.json({ items }, 200);
});

export { app as adminNavigationRoutes };
