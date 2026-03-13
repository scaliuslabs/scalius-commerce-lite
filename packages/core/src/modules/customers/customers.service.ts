// src/modules/customers/customers.service.ts
// All DB queries and business logic for the customers domain.

import { customers, customerHistory, deliveryLocations } from "@scalius/database/schema";
import { sql, and, isNull, inArray, asc, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { ftsMatch } from "../../search/fts5";
import { phoneNumberSchema } from "@scalius/shared/customer-utils";
import { z } from "zod";

// ─────────────────────────────────────────
// Schema
// ─────────────────────────────────────────

export const createCustomerSchema = z.object({
    name: z.string().min(3).max(100),
    email: z.email().nullable(),
    phone: phoneNumberSchema,
    address: z.string().max(500).nullable(),
    city: z.string().nullable(),
    zone: z.string().nullable(),
    area: z.string().nullable(),
});

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

// ─────────────────────────────────────────
// Queries
// ─────────────────────────────────────────

export async function listCustomers(
    db: any,
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
        limit = 10,
        search = "",
        showTrashed = false,
        sort = "updatedAt",
        order = "desc",
    } = options;

    const whereConditions: any[] = [];
    if (showTrashed) {
        whereConditions.push(sql`${customers.deletedAt} IS NOT NULL`);
    } else {
        whereConditions.push(sql`${customers.deletedAt} IS NULL`);
    }
    if (search) {
        const cond = ftsMatch("customers_fts", "customers", search);
        if (cond) whereConditions.push(cond);
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

    const [[{ count }], results] = await db.batch([countQuery, resultsQuery]);

    const formattedCustomers = results.map((c: any) => ({
        ...c,
        lastOrderAt: c.lastOrderAt ? new Date(c.lastOrderAt * 1000).toISOString() : null,
        createdAt: new Date(c.createdAt * 1000).toISOString(),
        updatedAt: new Date(c.updatedAt * 1000).toISOString(),
    }));

    // Enrich with location names
    const allLocationIds = [
        ...new Set(formattedCustomers.flatMap((c: any) => [c.city, c.zone, c.area]).filter(Boolean)),
    ] as string[];

    let locationMap = new Map<string, string>();
    if (allLocationIds.length > 0) {
        const locationResults = await db
            .select({ id: deliveryLocations.id, name: deliveryLocations.name })
            .from(deliveryLocations)
            .where(and(inArray(deliveryLocations.id, allLocationIds), isNull(deliveryLocations.deletedAt)));
        locationResults.forEach((loc: any) => locationMap.set(loc.id, loc.name));
    }

    const enhanced = formattedCustomers.map((c: any) => ({
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
    db: any,
    data: CreateCustomerInput,
): Promise<{ id: string }> {
    const existing = await db
        .select({ id: customers.id })
        .from(customers)
        .where(sql`${customers.phone} = ${data.phone}`)
        .get();

    if (existing) throw Object.assign(new Error("Customer with this phone number already exists"), { statusCode: 400 });

    const locationIds = [data.city, data.zone, data.area].filter(Boolean) as string[];
    let cityName = null, zoneName = null, areaName = null;

    if (locationIds.length > 0) {
        const locs = await db
            .select({ id: deliveryLocations.id, name: deliveryLocations.name })
            .from(deliveryLocations)
            .where(sql`${deliveryLocations.id} IN ${locationIds}`);
        const locMap = new Map(locs.map((l: any) => [l.id, l.name]));
        if (data.city) cityName = locMap.get(data.city) ?? null;
        if (data.zone) zoneName = locMap.get(data.zone) ?? null;
        if (data.area) areaName = locMap.get(data.area) ?? null;
    }

    const customerId = "cust_" + nanoid();
    await db.insert(customers).values({
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
    });

    await db.insert(customerHistory).values({
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
    });

    return { id: customerId };
}

export const updateCustomerSchema = createCustomerSchema.partial();
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

export async function getCustomerById(db: any, id: string) {
    return db.select().from(customers).where(eq(customers.id, id)).get() ?? null;
}

export async function updateCustomer(
    db: any,
    id: string,
    data: UpdateCustomerInput,
) {
    const existing = await getCustomerById(db, id);
    if (!existing) throw Object.assign(new Error("Customer not found"), { statusCode: 404 });

    if (data.phone && data.phone !== existing.phone) {
        const phoneConflict = await db
            .select({ id: customers.id })
            .from(customers)
            .where(sql`${customers.phone} = ${data.phone} AND ${customers.id} != ${id}`)
            .get();
        if (phoneConflict) throw Object.assign(new Error("Another customer with this phone number already exists"), { statusCode: 400 });
    }

    let cityName = existing.cityName, zoneName = existing.zoneName, areaName = existing.areaName;
    const locationIds = [data.city ?? existing.city, data.zone ?? existing.zone, data.area ?? existing.area].filter(Boolean) as string[];

    if ((data.city !== undefined || data.zone !== undefined || data.area !== undefined) && locationIds.length > 0) {
        const locs = await db
            .select({ id: deliveryLocations.id, name: deliveryLocations.name })
            .from(deliveryLocations)
            .where(inArray(deliveryLocations.id, locationIds));
        const locMap = new Map(locs.map((l: any) => [l.id, l.name]));
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

    await db.update(customers).set(updateData).where(eq(customers.id, id));

    await db.insert(customerHistory).values({
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
    });

    return { success: true };
}

export async function deleteCustomer(db: any, id: string): Promise<void> {
    await db.update(customers).set({ deletedAt: sql`unixepoch()` }).where(eq(customers.id, id));
}

export async function permanentDeleteCustomer(db: any, id: string): Promise<void> {
    await db.delete(customerHistory).where(eq(customerHistory.customerId, id));
    await db.delete(customers).where(eq(customers.id, id));
}

export async function restoreCustomer(db: any, id: string): Promise<void> {
    await db.update(customers).set({ deletedAt: null }).where(eq(customers.id, id));
}

export async function bulkDeleteCustomers(db: any, ids: string[], permanent = false): Promise<void> {
    if (permanent) {
        await db.delete(customerHistory).where(inArray(customerHistory.customerId, ids));
        await db.delete(customers).where(inArray(customers.id, ids));
    } else {
        await db.update(customers).set({ deletedAt: sql`unixepoch()` }).where(inArray(customers.id, ids));
    }
}
