// src/server/routes/admin/customers.ts
// Admin OpenAPI routes for customers.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
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
    bulkDeleteCustomers
} from "@scalius/core/modules/customers";
import { NotFoundError } from "../../utils/api-error";

const app = new OpenAPIHono();

// ── List Customers ──

const listRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Customers"],
    summary: "List all customers",
    request: {
        query: z.object({
            page: z.coerce.number().default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().default(10).openapi({ description: "Items per page" }),
            search: z.string().optional().default("").openapi({ description: "Search term" }),
            trashed: z.string().optional().openapi({ description: "Show trashed items" }),
            sort: z.string().optional().default("updatedAt").openapi({ description: "Sort field" }),
            order: z.string().optional().default("desc").openapi({ description: "Sort order" })
        })
    },
    responses: {
        200: { description: "Customer list with pagination"  }
    }
});

app.openapi(listRoute, async (c) => {
    const db = c.get("db");
    const q = c.req.valid("query");
    const result = await listCustomers(db, {
        page: q.page,
        limit: q.limit,
        search: q.search || "",
        showTrashed: q.trashed === "true",
        sort: (q.sort as any) || "updatedAt",
        order: (q.order as any) || "desc"
    });
    return c.json(result, 200);
});

// ── Create Customer ──

const createCustomerRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["Admin - Customers"],
    summary: "Create a customer",
    request: {
        body: { content: { "application/json": { schema: createCustomerSchema } } }
    },
    responses: {
        201: { description: "Customer created"  }
    }
});

app.openapi(createCustomerRoute, async (c) => {
    const db = c.get("db");
    const data = c.req.valid("json");
    try {
        const result = await createCustomer(db, data);
        return c.json(result, 201);
    } catch (error: any) {
        return c.json({ error: error.message }, error.statusCode || 400);
    }
});

// ── Bulk Delete Customers ──

const bulkDeleteRoute = createRoute({
    method: "post",
    path: "/bulk-delete",
    tags: ["Admin - Customers"],
    summary: "Bulk delete customers",
    request: {
        body: {
            content: {
                "application/json": {
                    schema: z.object({
                        customerIds: z.array(z.string()),
                        permanent: z.boolean().default(false)
                    })
                }
            }
        }
    },
    responses: {
        204: { description: "Customers deleted" }
    }
});

app.openapi(bulkDeleteRoute, async (c) => {
    const db = c.get("db");
    const { customerIds, permanent } = c.req.valid("json");
    await bulkDeleteCustomers(db, customerIds, permanent);
    return c.body(null, 204);
});

// ── Get Customer By ID ──

const getByIdRoute = createRoute({
    method: "get",
    path: "/{id}",
    tags: ["Admin - Customers"],
    summary: "Get a customer by ID",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: { description: "Customer details"  }
    }
});

app.openapi(getByIdRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const customer = await getCustomerById(db, id);
    if (!customer) throw new NotFoundError("Customer not found");
    return c.json(customer, 200);
});

// ── Update Customer ──

const updateCustomerRoute = createRoute({
    method: "put",
    path: "/{id}",
    tags: ["Admin - Customers"],
    summary: "Update a customer",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: updateCustomerSchema } } }
    },
    responses: {
        200: { description: "Customer updated"  }
    }
});

app.openapi(updateCustomerRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    try {
        await updateCustomer(db, id, c.req.valid("json"));
        return c.json({ success: true }, 200);
    } catch (error: any) {
        return c.json({ error: error.message }, error.statusCode || 400);
    }
});

// ── Delete Customer ──

const deleteCustomerRoute = createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Admin - Customers"],
    summary: "Soft-delete a customer",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        204: { description: "Customer deleted" }
    }
});

app.openapi(deleteCustomerRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await deleteCustomer(db, id);
    return c.body(null, 204);
});

// ── Permanent Delete Customer ──

const permanentDeleteRoute = createRoute({
    method: "delete",
    path: "/{id}/permanent",
    tags: ["Admin - Customers"],
    summary: "Permanently delete a customer",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        204: { description: "Customer permanently deleted" }
    }
});

app.openapi(permanentDeleteRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await permanentDeleteCustomer(db, id);
    return c.body(null, 204);
});

// ── Restore Customer ──

const restoreCustomerRoute = createRoute({
    method: "post",
    path: "/{id}/restore",
    tags: ["Admin - Customers"],
    summary: "Restore a soft-deleted customer",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        204: { description: "Customer restored" }
    }
});

app.openapi(restoreCustomerRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await restoreCustomer(db, id);
    return c.body(null, 204);
});

export { app as adminCustomerRoutes };
