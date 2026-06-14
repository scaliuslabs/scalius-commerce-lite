// src/modules/customers/customers.service.ts
// All DB queries and business logic for the customers domain.

import { customers, customerHistory, deliveryLocations, orders, orderItems, products, productVariants, productImages } from "@scalius/database/schema";
import { sql, isNull, inArray, asc, desc, eq, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import { ftsMatch } from "../../search/fts5";
import type { Database } from "@scalius/database/client";
import { NotFoundError, ValidationError } from "@scalius/core/errors";

// Re-export schemas from the canonical validation module
export {
    createCustomerSchema,
    updateCustomerSchema,
    type CreateCustomerInput,
    type UpdateCustomerInput,
} from "./customers.validation";
import type { CreateCustomerInput, UpdateCustomerInput } from "./customers.validation";

// ─────────────────────────────────────────
// Queries
// ─────────────────────────────────────────

export async function listCustomers(
    db: Database,
    options: {
        page?: number;
        limit?: number;
        search?: string;
        showTrashed?: boolean;
        sort?: "name" | "totalOrders" | "totalSpent" | "lastOrderAt" | "createdAt" | "updatedAt";
        order?: "asc" | "desc";
    } = {},
) {
    const {
        page = 1,
        limit: rawLimit = 10,
        search = "",
        showTrashed = false,
        sort = "updatedAt",
        order = "desc",
    } = options;
    const limit = Math.min(Math.max(rawLimit, 1), 100);

    const whereConditions: (SQL | undefined)[] = [];
    if (showTrashed) {
        whereConditions.push(sql`${customers.deletedAt} IS NOT NULL`);
    } else {
        whereConditions.push(sql`${customers.deletedAt} IS NULL`);
    }
    if (search) {
        const digitsOnly = search.replace(/[^0-9]/g, "");
        const looksLikePhone = digitsOnly.length >= 4 && digitsOnly.length / search.replace(/\s/g, "").length > 0.5;
        const ftsCondition = ftsMatch("customers_fts", "customers", search);

        if (looksLikePhone && ftsCondition) {
            whereConditions.push(sql`(${ftsCondition} OR ${customers.phone} LIKE ${"%" + digitsOnly + "%"})`);
        } else if (looksLikePhone) {
            whereConditions.push(sql`${customers.phone} LIKE ${"%" + digitsOnly + "%"}`);
        } else if (ftsCondition) {
            whereConditions.push(ftsCondition);
        }
    }

    const whereClause =
        whereConditions.length > 0
            ? sql`${sql.join(whereConditions, sql` AND `)}`
            : undefined;

    const offset = (page - 1) * limit;

    const sortField = (() => {
        switch (sort) {
            case "name": return customers.name;
            case "totalOrders": return customers.totalOrders;
            case "totalSpent": return customers.totalSpent;
            case "lastOrderAt": return customers.lastOrderAt;
            case "createdAt": return customers.createdAt;
            default: return customers.updatedAt;
        }
    })();

    const countQuery = db
        .select({ count: sql<number>`count(*)` })
        .from(customers)
        .where(whereClause);

    const resultsQuery = db
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
        .where(whereClause)
        .limit(limit)
        .offset(offset)
        .orderBy(order === "asc" ? asc(sortField) : desc(sortField));

    // Batch customer count, results, and all location names in a single D1 round-trip
    const locationQuery = db
        .select({ id: deliveryLocations.id, name: deliveryLocations.name })
        .from(deliveryLocations)
        .where(isNull(deliveryLocations.deletedAt));

    const [countArr, results, locationResults] = await db.batch([
        countQuery,
        resultsQuery,
        locationQuery,
    ] as Parameters<Database["batch"]>[0]) as [
        { count: number }[],
        { id: string; name: string; email: string | null; phone: string; address: string | null; city: string | null; zone: string | null; area: string | null; totalOrders: number; totalSpent: number; lastOrderAt: number; createdAt: number; updatedAt: number }[],
        { id: string; name: string }[],
    ];
    const count = countArr[0]?.count ?? 0;

    const locationMap = new Map<string, string>();
    locationResults.forEach((loc) => locationMap.set(loc.id, loc.name));

    const formattedCustomers = results.map((c) => ({
        ...c,
        lastOrderAt: c.lastOrderAt ? new Date(c.lastOrderAt * 1000).toISOString() : null,
        createdAt: new Date(c.createdAt * 1000).toISOString(),
        updatedAt: new Date(c.updatedAt * 1000).toISOString(),
    }));

    const enhanced = formattedCustomers.map((c) => ({
        ...c,
        cityName: c.city ? locationMap.get(c.city) ?? c.city : null,
        zoneName: c.zone ? locationMap.get(c.zone) ?? c.zone : null,
        areaName: c.area ? locationMap.get(c.area) ?? c.area : null,
    }));

    return {
        customers: enhanced,
        pagination: { total: count, page, limit, totalPages: Math.ceil(count / limit) },
    };
}

// ─────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────

export async function createCustomer(
    db: Database,
    data: CreateCustomerInput,
): Promise<{ id: string }> {
    const existing = await db
        .select({ id: customers.id })
        .from(customers)
        .where(sql`${customers.phone} = ${data.phone}`)
        .get();

    if (existing) throw new ValidationError("Customer with this phone number already exists");

    const locationIds = [data.city, data.zone, data.area].filter(Boolean) as string[];
    let cityName = null, zoneName = null, areaName = null;

    if (locationIds.length > 0) {
        const locs = await db
            .select({ id: deliveryLocations.id, name: deliveryLocations.name })
            .from(deliveryLocations)
            .where(sql`${deliveryLocations.id} IN ${locationIds}`);
        const locMap = new Map(locs.map((l) => [l.id, l.name]));
        if (data.city) cityName = locMap.get(data.city) ?? null;
        if (data.zone) zoneName = locMap.get(data.zone) ?? null;
        if (data.area) areaName = locMap.get(data.area) ?? null;
    }

    const customerId = "cust_" + nanoid();
    await db.batch([
        db.insert(customers).values({
            id: customerId,
            name: data.name,
            email: data.email,
            phone: data.phone,
            address: data.address,
            city: data.city,
            zone: data.zone,
            area: data.area,
            cityName,
            zoneName,
            areaName,
            totalOrders: 0,
            totalSpent: 0,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        }),
        db.insert(customerHistory).values({
            id: "hist_" + nanoid(),
            customerId,
            name: data.name,
            email: data.email,
            phone: data.phone,
            address: data.address,
            city: data.city,
            zone: data.zone,
            area: data.area,
            cityName,
            zoneName,
            areaName,
            changeType: "created",
            createdAt: sql`unixepoch()`,
        }),
    ] as Parameters<Database["batch"]>[0]);

    return { id: customerId };
}

export async function getCustomerById(db: Database, id: string) {
    return db.select().from(customers).where(eq(customers.id, id)).get() ?? null;
}

export async function updateCustomer(
    db: Database,
    id: string,
    data: UpdateCustomerInput,
) {
    const existing = await getCustomerById(db, id);
    if (!existing) throw new NotFoundError("Customer not found");

    if (data.phone && data.phone !== existing.phone) {
        const phoneConflict = await db
            .select({ id: customers.id })
            .from(customers)
            .where(sql`${customers.phone} = ${data.phone} AND ${customers.id} != ${id}`)
            .get();
        if (phoneConflict) throw new ValidationError("Another customer with this phone number already exists");
    }

    let cityName = existing.cityName, zoneName = existing.zoneName, areaName = existing.areaName;
    const locationIds = [data.city ?? existing.city, data.zone ?? existing.zone, data.area ?? existing.area].filter(Boolean) as string[];

    if ((data.city !== undefined || data.zone !== undefined || data.area !== undefined) && locationIds.length > 0) {
        const locs = await db
            .select({ id: deliveryLocations.id, name: deliveryLocations.name })
            .from(deliveryLocations)
            .where(inArray(deliveryLocations.id, locationIds));
        const locMap = new Map(locs.map((l) => [l.id, l.name]));
        if (data.city !== undefined) cityName = data.city ? locMap.get(data.city) ?? null : null;
        if (data.zone !== undefined) zoneName = data.zone ? locMap.get(data.zone) ?? null : null;
        if (data.area !== undefined) areaName = data.area ? locMap.get(data.area) ?? null : null;
    }

    const updateData = {
        ...data,
        cityName,
        zoneName,
        areaName,
        updatedAt: sql`unixepoch()`,
    };

    await db.batch([
        db.update(customers).set(updateData).where(eq(customers.id, id)),
        db.insert(customerHistory).values({
            id: "hist_" + nanoid(),
            customerId: id,
            name: data.name ?? existing.name,
            email: data.email !== undefined ? data.email : existing.email,
            phone: data.phone ?? existing.phone,
            address: data.address !== undefined ? data.address : existing.address,
            city: data.city !== undefined ? data.city : existing.city,
            zone: data.zone !== undefined ? data.zone : existing.zone,
            area: data.area !== undefined ? data.area : existing.area,
            cityName,
            zoneName,
            areaName,
            changeType: "updated",
            createdAt: sql`unixepoch()`,
        }),
    ] as Parameters<Database["batch"]>[0]);

}


export async function deleteCustomer(db: Database, id: string): Promise<void> {
    const existing = await getCustomerById(db, id);
    if (!existing) throw new NotFoundError("Customer not found");

    await db.batch([
        db.update(customers).set({ deletedAt: sql`unixepoch()` }).where(eq(customers.id, id)),
        db.insert(customerHistory).values({
            id: "hist_" + nanoid(),
            customerId: id,
            name: existing.name,
            email: existing.email,
            phone: existing.phone,
            address: existing.address,
            city: existing.city,
            zone: existing.zone,
            area: existing.area,
            cityName: existing.cityName,
            zoneName: existing.zoneName,
            areaName: existing.areaName,
            changeType: "deleted",
            createdAt: sql`unixepoch()`,
        }),
    ] as Parameters<Database["batch"]>[0]);
}

export async function permanentlyDeleteCustomer(db: Database, id: string): Promise<void> {
    await db.batch([
        db.delete(customerHistory).where(eq(customerHistory.customerId, id)),
        db.delete(customers).where(eq(customers.id, id)),
    ] as Parameters<Database["batch"]>[0]);
}

export async function restoreCustomer(db: Database, id: string): Promise<void> {
    await db.update(customers).set({ deletedAt: null }).where(eq(customers.id, id));
}

export async function bulkDeleteCustomers(db: Database, ids: string[], permanent = false): Promise<void> {
    if (permanent) {
        await db.delete(customerHistory).where(inArray(customerHistory.customerId, ids));
        await db.delete(customers).where(inArray(customers.id, ids));
    } else {
        await db.update(customers).set({ deletedAt: sql`unixepoch()` }).where(inArray(customers.id, ids));
    }
}

// ─────────────────────────────────────────
// Customer Orders (storefront)
// ─────────────────────────────────────────

export async function getCustomerOrders(
    db: Database,
    customerId: string,
) {
    // Fetch full customer profile from DB
    const dbCustomer = await db
        .select()
        .from(customers)
        .where(eq(customers.id, customerId))
        .get();

    const customerProfile = dbCustomer
        ? {
            id: dbCustomer.id,
            name: dbCustomer.name || "Customer",
            email: dbCustomer.email || "",
            phone: dbCustomer.phone || "",
            address: dbCustomer.address,
            cityName: dbCustomer.cityName,
            zoneName: dbCustomer.zoneName,
            city: dbCustomer.city,
            zone: dbCustomer.zone,
        }
        : null;

    const customerOrders = await db
        .select({
            id: orders.id,
            status: orders.status,
            totalAmount: orders.totalAmount,
            paidAmount: orders.paidAmount,
            shippingCharge: orders.shippingCharge,
            discountAmount: orders.discountAmount,
            paymentStatus: orders.paymentStatus,
            paymentMethod: orders.paymentMethod,
            fulfillmentStatus: orders.fulfillmentStatus,
            shippingAddress: orders.shippingAddress,
            cityName: orders.cityName,
            zoneName: orders.zoneName,
            notes: orders.notes,
            createdAt: sql<number>`CAST(${orders.createdAt} AS INTEGER)`
        })
        .from(orders)
        .where(eq(orders.customerId, customerId))
        .orderBy(desc(orders.createdAt))
        .limit(50);

    // Fetch items for all orders in one batch
    const orderIds = customerOrders.map((o) => o.id);
    const itemsByOrder = new Map<string, Array<Record<string, unknown>>>();

    if (orderIds.length > 0) {
        const allItems = await db
            .select({
                orderId: orderItems.orderId,
                productId: orderItems.productId,
                variantId: orderItems.variantId,
                quantity: orderItems.quantity,
                price: orderItems.price,
                productName: products.name,
                productSlug: products.slug,
                productImage: sql<string>`(
                    SELECT ${productImages.url}
                    FROM ${productImages}
                    WHERE ${productImages.productId} = ${products.id}
                    AND ${productImages.isPrimary} = 1
                    LIMIT 1
                )`.as("productImage"),
                variantSize: productVariants.size,
                variantColor: productVariants.color
            })
            .from(orderItems)
            .leftJoin(products, eq(products.id, orderItems.productId))
            .leftJoin(productVariants, eq(productVariants.id, orderItems.variantId))
            .where(sql`${orderItems.orderId} IN ${orderIds}`);

        for (const item of allItems) {
            const list = itemsByOrder.get(item.orderId) || [];
            list.push(item);
            itemsByOrder.set(item.orderId, list);
        }
    }

    // Format response
    const formattedOrders = customerOrders.map((order) => ({
        ...order,
        createdAt: order.createdAt
            ? new Date(order.createdAt * 1000).toISOString()
            : null,
        items: itemsByOrder.get(order.id) || []
    }));

    return { orders: formattedOrders, customerProfile };
}
