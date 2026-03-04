// src/server/routes/admin/customers.ts
// Admin Hono routes for customers.
// All DB logic is delegated to src/modules/customers/customers.service.ts.

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
    listCustomers,
    createCustomer,
    createCustomerSchema,
    getCustomerById,
    updateCustomer,
    updateCustomerSchema,
    deleteCustomer,
    permanentDeleteCustomer,
    restoreCustomer,
    bulkDeleteCustomers,
} from "@/modules/customers";
import { z } from "zod";

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

// POST /admin/customers/bulk-delete
app.post("/bulk-delete", zValidator("json", z.object({ customerIds: z.array(z.string()), permanent: z.boolean().default(false) })), async (c) => {
    const db = c.get("db");
    const { customerIds, permanent } = c.req.valid("json");
    await bulkDeleteCustomers(db, customerIds, permanent);
    return c.body(null, 204);
});

// GET /admin/customers/:id
app.get("/:id", async (c) => {
    const db = c.get("db");
    const customer = await getCustomerById(db, c.req.param("id"));
    if (!customer) return c.json({ error: "Customer not found" }, 404);
    return c.json(customer);
});

// PUT /admin/customers/:id
app.put("/:id", zValidator("json", updateCustomerSchema), async (c) => {
    const db = c.get("db");
    try {
        await updateCustomer(db, c.req.param("id"), c.req.valid("json"));
        return c.json({ success: true });
    } catch (error: any) {
        return c.json({ error: error.message }, error.statusCode || 400);
    }
});

// DELETE /admin/customers/:id
app.delete("/:id", async (c) => {
    const db = c.get("db");
    await deleteCustomer(db, c.req.param("id"));
    return c.body(null, 204);
});

// DELETE /admin/customers/:id/permanent
app.delete("/:id/permanent", async (c) => {
    const db = c.get("db");
    await permanentDeleteCustomer(db, c.req.param("id"));
    return c.body(null, 204);
});

// POST /admin/customers/:id/restore
app.post("/:id/restore", async (c) => {
    const db = c.get("db");
    await restoreCustomer(db, c.req.param("id"));
    return c.body(null, 204);
});

export { app as adminCustomerRoutes };
