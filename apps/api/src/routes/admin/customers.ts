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
    permanentlyDeleteCustomer,
    restoreCustomer,
    bulkDeleteCustomers
} from "@scalius/core/modules/customers";
import { customers, customerHistory, orders, deliveryLocations } from "@scalius/database/schema";
import { eq, sql, inArray, isNull, and } from "drizzle-orm";
import { NotFoundError } from "../../utils/api-error";

import { ok, created, noContent } from "../../utils/api-response";
import { successEnvelope, paginatedEnvelope, idResponse, noContentResponse, errorResponses } from "../../schemas/responses";
import { customerSummarySchema, customerDetailSchema } from "../../schemas/entities";
import { timestampSchema, nullableTimestampSchema, optionalNullableTimestampSchema } from "../../schemas/timestamps";
const app = new OpenAPIHono<{ Bindings: Env }>();

// ── List Customers ──

const listRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Customers"],
    summary: "List all customers",
    request: {
        query: z.object({
            page: z.coerce.number().default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().max(100).default(10).openapi({ description: "Items per page" }),
            search: z.string().optional().default("").openapi({ description: "Search term" }),
            trashed: z.string().optional().openapi({ description: "Show trashed items" }),
            sort: z.string().optional().default("updatedAt").openapi({ description: "Sort field" }),
            order: z.string().optional().default("desc").openapi({ description: "Sort order" })
        })
    },
    responses: {
        200: { description: "Customer list with pagination", content: { "application/json": { schema: paginatedEnvelope("customers", customerSummarySchema) } } },
        ...errorResponses,
    }
});

const customerHistoryEntrySchema = z.object({
    id: z.string(),
    name: z.string(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    address: z.string().nullable(),
    city: z.string().nullable(),
    zone: z.string().nullable(),
    area: z.string().nullable(),
    cityName: z.string().nullable(),
    zoneName: z.string().nullable(),
    areaName: z.string().nullable(),
    changeType: z.string(),
    createdAt: timestampSchema,
});

const customerHistoryOrderSchema = z.object({
    id: z.string(),
    totalAmount: z.number(),
    status: z.string(),
    createdAt: timestampSchema,
});

const customerHistoryCustomerSchema = customerDetailSchema.extend({
    lastOrderAt: nullableTimestampSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    deletedAt: optionalNullableTimestampSchema,
});

const customerHistoryPayloadSchema = z.object({
    customer: customerHistoryCustomerSchema,
    history: z.array(customerHistoryEntrySchema),
    orders: z.array(customerHistoryOrderSchema),
});

app.openapi(listRoute, async (c) => {
    const db = c.get("db");
    const q = c.req.valid("query");
    const result = await listCustomers(db, {
        page: q.page,
        limit: q.limit,
        search: q.search || "",
        showTrashed: q.trashed === "true",
        sort: q.sort as "name" | "totalOrders" | "totalSpent" | "lastOrderAt" | "createdAt" | "updatedAt" | undefined,
        order: q.order as "asc" | "desc" | undefined
    });
    return ok(c, result);
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
        201: { description: "Customer created", content: { "application/json": { schema: idResponse } } },
        ...errorResponses,
    }
});

app.openapi(createCustomerRoute, async (c) => {
    const db = c.get("db");
    const data = c.req.valid("json");
    const result = await createCustomer(db, data);
    return created(c, result);
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
        204: noContentResponse,
    }
});

app.openapi(bulkDeleteRoute, async (c) => {
    const db = c.get("db");
    const { customerIds, permanent } = c.req.valid("json");
    await bulkDeleteCustomers(db, customerIds, permanent);
    return noContent(c);
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
        200: { description: "Customer details", content: { "application/json": { schema: successEnvelope(customerDetailSchema) } } },
        ...errorResponses,
    }
});

app.openapi(getByIdRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const customer = await getCustomerById(db, id);
    if (!customer) throw new NotFoundError("Customer not found");
    return ok(c, customer);
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
        200: { description: "Customer updated", content: { "application/json": { schema: successEnvelope(z.object({})) } } },
        ...errorResponses,
    }
});

app.openapi(updateCustomerRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await updateCustomer(db, id, c.req.valid("json"));
    return ok(c, {});
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
        204: noContentResponse,
    }
});

app.openapi(deleteCustomerRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await deleteCustomer(db, id);
    return noContent(c);
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
        204: noContentResponse,
    }
});

app.openapi(permanentDeleteRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await permanentlyDeleteCustomer(db, id);
    return noContent(c);
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
        204: noContentResponse,
    }
});

app.openapi(restoreCustomerRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await restoreCustomer(db, id);
    return noContent(c);
});

// ── Get Customer History ──

const getHistoryRoute = createRoute({
    method: "get",
    path: "/{id}/history",
    tags: ["Admin - Customers"],
    summary: "Get customer details with history and orders",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: { description: "Customer history data", content: { "application/json": { schema: successEnvelope(customerHistoryPayloadSchema) } } },
        ...errorResponses,
    }
});

app.openapi(getHistoryRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");

    const [customerResults, history, customerOrders] = await db.batch([
        db
            .select({
                id: customers.id,
                name: customers.name,
                email: customers.email,
                phone: customers.phone,
                address: customers.address,
                city: customers.city,
                zone: customers.zone,
                area: customers.area,
                totalOrders: customers.totalOrders,
                totalSpent: customers.totalSpent,
                lastOrderAt: sql<number>`CAST(${customers.lastOrderAt} AS INTEGER)`,
                createdAt: sql<number>`CAST(${customers.createdAt} AS INTEGER)`,
                updatedAt: sql<number>`CAST(${customers.updatedAt} AS INTEGER)`,
            })
            .from(customers)
            .where(eq(customers.id, id)),
        db
            .select({
                id: customerHistory.id,
                name: customerHistory.name,
                email: customerHistory.email,
                phone: customerHistory.phone,
                address: customerHistory.address,
                city: customerHistory.city,
                zone: customerHistory.zone,
                area: customerHistory.area,
                cityName: customerHistory.cityName,
                zoneName: customerHistory.zoneName,
                areaName: customerHistory.areaName,
                changeType: customerHistory.changeType,
                createdAt: sql<number>`CAST(${customerHistory.createdAt} AS INTEGER)`,
            })
            .from(customerHistory)
            .where(eq(customerHistory.customerId, id))
            .orderBy(sql`${customerHistory.createdAt} DESC`),
        db
            .select({
                id: orders.id,
                totalAmount: orders.totalAmount,
                status: orders.status,
                createdAt: sql<number>`CAST(${orders.createdAt} AS INTEGER)`,
            })
            .from(orders)
            .where(eq(orders.customerId, id))
            .orderBy(sql`${orders.createdAt} DESC`),
    ]);

    const customer = customerResults[0];
    if (!customer) throw new NotFoundError("Customer not found");

    // Collect location IDs for name enrichment
    const locationIds = new Set<string>();
    if (customer.city) locationIds.add(customer.city);
    if (customer.zone) locationIds.add(customer.zone);
    if (customer.area) locationIds.add(customer.area);
    for (const record of history) {
        if (record.city) locationIds.add(record.city);
        if (record.zone) locationIds.add(record.zone);
        if (record.area) locationIds.add(record.area);
    }

    const locationArray = Array.from(locationIds).filter(Boolean) as string[];
    const locationMap = new Map<string, string>();
    if (locationArray.length > 0) {
        const locations = await db
            .select({ id: deliveryLocations.id, name: deliveryLocations.name })
            .from(deliveryLocations)
            .where(and(inArray(deliveryLocations.id, locationArray), isNull(deliveryLocations.deletedAt)));
        locations.forEach((loc) => locationMap.set(loc.id, loc.name));
    }

    const enrichedCustomer = {
        ...customer,
        lastOrderAt: customer.lastOrderAt ? new Date(customer.lastOrderAt * 1000) : null,
        createdAt: new Date(customer.createdAt * 1000),
        updatedAt: new Date(customer.updatedAt * 1000),
        cityName: customer.city ? locationMap.get(customer.city) || customer.city : "",
        zoneName: customer.zone ? locationMap.get(customer.zone) || customer.zone : "",
        areaName: customer.area ? locationMap.get(customer.area) || customer.area : null,
    };

    const enrichedHistory = history.map((record) => ({
        ...record,
        createdAt: new Date(record.createdAt * 1000),
        cityName: record.city ? locationMap.get(record.city) || record.city : "",
        zoneName: record.zone ? locationMap.get(record.zone) || record.zone : "",
        areaName: record.area ? locationMap.get(record.area) || record.area : null,
    }));

    const enrichedOrders = customerOrders.map((order) => ({
        ...order,
        createdAt: new Date(order.createdAt * 1000),
    }));

    return ok(c, {
        customer: enrichedCustomer,
        history: enrichedHistory,
        orders: enrichedOrders,
    });
});

export { app as adminCustomerRoutes };
