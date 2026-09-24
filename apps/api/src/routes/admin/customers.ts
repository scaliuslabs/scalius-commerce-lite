// src/server/routes/admin/customers.ts
// Admin OpenAPI routes for customers.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    listCustomers,
    createCustomer,
    createCustomerSchema,
    getCustomerDetail,
    updateCustomer,
    updateCustomerSchema,
    deleteCustomer,
    permanentlyDeleteCustomer,
    restoreCustomer,
    bulkDeleteCustomers,
    buildCustomerOrderMetricsProjection,
    paidSpendAmount,
} from "@scalius/core/modules/customers";
import { fromMinor } from "@scalius/shared/money";
import { customers, customerHistory, orders, deliveryLocations } from "@scalius/database/schema";
import { eq, sql, inArray, isNull, and } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { NotFoundError } from "../../utils/api-error";

import { ok, created, noContent } from "../../utils/api-response";
import { successEnvelope, paginatedEnvelope, idResponse, noContentResponse, errorResponses } from "../../schemas/responses";
import { customerSummarySchema, customerDetailSchema } from "../../schemas/entities";
import { timestampSchema, nullableTimestampSchema, optionalNullableTimestampSchema } from "../../schemas/timestamps";
const app = new OpenAPIHono<{ Bindings: Env }>();

// ── List Customers ──

const listRoute = createRoute({
    operationId: "dashboard.customers.list",
    method: "get",
    path: "/",
    tags: ["Admin - Customers"],
    summary: "List all customers",
    description: "Find recent or new customers and search bounded customer summaries.",
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
    changeType: z.string().openapi({ description: "created, updated, deleted, or order_moved_in / order_moved_out (see `order` and `relatedCustomer`)" }),
    /** The order that moved, for order_moved_in / order_moved_out. */
    order: z.object({ id: z.string(), orderNumber: z.number().int().nullable() }).nullable(),
    /** The other record in the move: the guest record it came from, or the account it went to. */
    relatedCustomer: z.object({ id: z.string(), name: z.string() }).nullable(),
    createdAt: timestampSchema,
});

const customerLinkSchema = z.object({ id: z.string(), name: z.string() });

const customerHistoryOrderSchema = z.object({
    id: z.string(),
    orderNumber: z.number().int().nullable(),
    totalAmount: z.number(),
    status: z.string(),
    createdAt: timestampSchema,
});

const customerHistoryCustomerSchema = customerDetailSchema.extend({
    lastOrderAt: nullableTimestampSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    deletedAt: optionalNullableTimestampSchema,
    /** On a guest record: the account that took its orders placed with a contact it proved (merged when `deletedAt` is set). */
    linkedAccount: customerLinkSchema.nullable(),
    /** On an account: guest records still holding orders placed with a contact it hasn't proven. */
    guestRecords: z.array(customerLinkSchema.extend({ orderCount: z.number().int() })),
});

const customerHistoryPayloadSchema = z.object({
    customer: customerHistoryCustomerSchema,
    history: z.array(customerHistoryEntrySchema),
    orders: z.array(customerHistoryOrderSchema),
    pagination: z.object({
        history: z.object({
            page: z.number(),
            limit: z.number(),
            total: z.number(),
            totalPages: z.number(),
            hasNextPage: z.boolean(),
        }),
        orders: z.object({
            page: z.number(),
            limit: z.number(),
            total: z.number(),
            totalPages: z.number(),
            hasNextPage: z.boolean(),
        }),
    }),
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
    operationId: "dashboard.customers.create",
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
    operationId: "dashboard.customers.bulk_delete",
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
    operationId: "dashboard.customers.get",
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
    const customer = await getCustomerDetail(db, id);
    if (!customer) throw new NotFoundError("Customer not found");
    return ok(c, customer);
});

// ── Update Customer ──

const updateCustomerRoute = createRoute({
    operationId: "dashboard.customers.update",
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
    operationId: "dashboard.customers.delete",
    method: "delete",
    path: "/{id}",
    tags: ["Admin - Customers"],
    summary: "Soft-delete a customer",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        204: noContentResponse,
        404: errorResponses[404],
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
    operationId: "dashboard.customers.delete_permanently",
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
    operationId: "dashboard.customers.restore",
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
    operationId: "dashboard.customers.history",
    method: "get",
    path: "/{id}/history",
    tags: ["Admin - Customers"],
    summary: "Get customer details with history and orders",
    request: {
        params: z.object({ id: z.string() }),
        query: z.object({
            historyPage: z.coerce.number().int().min(1).default(1),
            historyLimit: z.coerce.number().int().min(1).max(50).default(20),
            ordersPage: z.coerce.number().int().min(1).default(1),
            ordersLimit: z.coerce.number().int().min(1).max(25).default(5),
        }),
    },
    responses: {
        200: { description: "Customer history data", content: { "application/json": { schema: successEnvelope(customerHistoryPayloadSchema) } } },
        ...errorResponses,
    }
});

app.openapi(getHistoryRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const { historyPage, historyLimit, ordersPage, ordersLimit } = c.req.valid("query");
    const metrics = buildCustomerOrderMetricsProjection();
    const historyOffset = (historyPage - 1) * historyLimit;
    const ordersOffset = (ordersPage - 1) * ordersLimit;

    const linkedAccount = alias(customers, "linked_account");
    const relatedCustomer = alias(customers, "related_customer");
    const movedOrder = alias(orders, "moved_order");
    const guestRecord = alias(customers, "guest_record");
    const [customerResults, history, customerOrders, historyCountRows, orderCountRows, guestRecords] = await db.batch([
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
                accountClaimedAt: sql<number | null>`CAST(${customers.accountClaimedAt} AS INTEGER)`,
                linkedAccountId: sql<string | null>`${linkedAccount.id}`.as("linked_account_id"),
                linkedAccountName: sql<string | null>`${linkedAccount.name}`.as("linked_account_name"),
                totalOrders: metrics.totalOrders,
                totalSpentMinor: metrics.totalSpentMinor,
                spendDecimalPlaces: metrics.spendDecimalPlaces,
                lastOrderAt: metrics.lastOrderAt,
                createdAt: sql<number>`CAST(${customers.createdAt} AS INTEGER)`,
                updatedAt: sql<number>`CAST(${customers.updatedAt} AS INTEGER)`,
                deletedAt: sql<number | null>`CAST(${customers.deletedAt} AS INTEGER)`,
            })
            .from(customers)
            .leftJoin(orders, and(
                eq(orders.customerId, customers.id),
                isNull(orders.deletedAt),
            ))
            .leftJoin(linkedAccount, and(
                eq(linkedAccount.id, customers.linkedAccountId),
                isNull(customers.accountClaimedAt),
            ))
            .where(eq(customers.id, id))
            .groupBy(customers.id, linkedAccount.id),
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
                orderId: customerHistory.orderId,
                orderNumber: sql<number | null>`${movedOrder.orderNumber}`.as("moved_order_number"),
                relatedCustomerId: customerHistory.relatedCustomerId,
                relatedCustomerName: sql<string | null>`${relatedCustomer.name}`.as("related_customer_name"),
                createdAt: sql<number>`CAST(${customerHistory.createdAt} AS INTEGER)`,
            })
            .from(customerHistory)
            .leftJoin(movedOrder, eq(movedOrder.id, customerHistory.orderId))
            .leftJoin(relatedCustomer, eq(relatedCustomer.id, customerHistory.relatedCustomerId))
            .where(eq(customerHistory.customerId, id))
            .orderBy(sql`${customerHistory.createdAt} DESC`)
            .limit(historyLimit)
            .offset(historyOffset),
        db
            .select({
                id: orders.id,
                orderNumber: orders.orderNumber,
                totalAmountMinor: orders.totalAmountMinor,
                currencyDecimalPlaces: orders.currencyDecimalPlaces,
                status: orders.status,
                createdAt: sql<number>`CAST(${orders.createdAt} AS INTEGER)`,
            })
            .from(orders)
            .where(and(
                eq(orders.customerId, id),
                isNull(orders.deletedAt),
            ))
            .orderBy(sql`${orders.createdAt} DESC`)
            .limit(ordersLimit)
            .offset(ordersOffset),
        db
            .select({ total: sql<number>`COUNT(*)` })
            .from(customerHistory)
            .where(eq(customerHistory.customerId, id)),
        db
            .select({ total: sql<number>`COUNT(*)` })
            .from(orders)
            .where(and(
                eq(orders.customerId, id),
                isNull(orders.deletedAt),
            )),
        db
            .select({ id: guestRecord.id, name: guestRecord.name, orderCount: sql<number>`COUNT(${orders.id})` })
            .from(guestRecord)
            .innerJoin(orders, and(eq(orders.customerId, guestRecord.id), isNull(orders.deletedAt)))
            .where(and(
                eq(guestRecord.linkedAccountId, id),
                isNull(guestRecord.accountClaimedAt),
                isNull(guestRecord.deletedAt),
            ))
            .groupBy(guestRecord.id),
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

    const { totalSpentMinor, spendDecimalPlaces, linkedAccountId, linkedAccountName, ...customerFacts } = customer;
    const enrichedCustomer = {
        ...customerFacts,
        deletedAt: customer.deletedAt ? new Date(customer.deletedAt * 1000) : null,
        linkedAccount: linkedAccountId ? { id: linkedAccountId, name: linkedAccountName ?? "" } : null,
        guestRecords: guestRecords.map((record) => ({ ...record, orderCount: Number(record.orderCount) })),
        totalSpent: paidSpendAmount({ totalSpentMinor, spendDecimalPlaces }),
        accountClaimedAt: customer.accountClaimedAt ? new Date(customer.accountClaimedAt * 1000) : null,
        lastOrderAt: customer.lastOrderAt ? new Date(customer.lastOrderAt * 1000) : null,
        createdAt: new Date(customer.createdAt * 1000),
        updatedAt: new Date(customer.updatedAt * 1000),
        cityName: customer.city ? locationMap.get(customer.city) || customer.city : "",
        zoneName: customer.zone ? locationMap.get(customer.zone) || customer.zone : "",
        areaName: customer.area ? locationMap.get(customer.area) || customer.area : null,
    };

    const enrichedHistory = history.map(({ orderId, orderNumber, relatedCustomerId, relatedCustomerName, ...record }) => ({
        ...record,
        order: orderId ? { id: orderId, orderNumber: orderNumber ?? null } : null,
        relatedCustomer: relatedCustomerId ? { id: relatedCustomerId, name: relatedCustomerName ?? "" } : null,
        createdAt: new Date(record.createdAt * 1000),
        cityName: record.city ? locationMap.get(record.city) || record.city : "",
        zoneName: record.zone ? locationMap.get(record.zone) || record.zone : "",
        areaName: record.area ? locationMap.get(record.area) || record.area : null,
    }));

    const enrichedOrders = customerOrders.map(({ totalAmountMinor, currencyDecimalPlaces, ...order }) => ({
        ...order,
        totalAmount: fromMinor(totalAmountMinor, currencyDecimalPlaces),
        createdAt: new Date(order.createdAt * 1000),
    }));

    const historyTotal = Number(historyCountRows[0]?.total ?? 0);
    const ordersTotal = Number(orderCountRows[0]?.total ?? 0);
    const historyTotalPages = Math.ceil(historyTotal / historyLimit);
    const ordersTotalPages = Math.ceil(ordersTotal / ordersLimit);

    return ok(c, {
        customer: enrichedCustomer,
        history: enrichedHistory,
        orders: enrichedOrders,
        pagination: {
            history: {
                page: historyPage,
                limit: historyLimit,
                total: historyTotal,
                totalPages: historyTotalPages,
                hasNextPage: historyPage < historyTotalPages,
            },
            orders: {
                page: ordersPage,
                limit: ordersLimit,
                total: ordersTotal,
                totalPages: ordersTotalPages,
                hasNextPage: ordersPage < ordersTotalPages,
            },
        },
    });
});

export { app as adminCustomerRoutes };
