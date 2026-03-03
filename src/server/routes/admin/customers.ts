// src/server/routes/admin/customers.ts
// Admin Hono routes for customers.
// All DB logic is delegated to src/modules/customers/customers.service.ts.

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { listCustomers, createCustomer, createCustomerSchema } from "@/modules/customers";

const app = new Hono<{ Bindings: Env }>();

// GET /admin/customers
app.get("/", async (c) => {
    const db = c.get("db");
    const q = c.req.query();
    const result = await listCustomers(db, {
        page: parseInt(q.page || "1"),
        limit: parseInt(q.limit || "10"),
        search: q.search || "",
        showTrashed: q.trashed === "true",
        sort: (q.sort as any) || "updatedAt",
        order: (q.order as any) || "desc",
    });
    return c.json(result);
});

// POST /admin/customers
app.post("/", zValidator("json", createCustomerSchema), async (c) => {
    const db = c.get("db");
    const data = c.req.valid("json");
    try {
        const result = await createCustomer(db, data);
        return c.json(result, 201);
    } catch (error: any) {
        return c.json({ error: error.message }, error.statusCode || 400);
    }
});

export { app as adminCustomerRoutes };
