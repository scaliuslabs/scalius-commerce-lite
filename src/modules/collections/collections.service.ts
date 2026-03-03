// src/modules/collections/collections.service.ts
// All DB queries and business logic for the collections domain.

import { collections } from "@/db/schema";
import { sql, and, isNull, isNotNull, eq, inArray, like, asc, desc, max } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { CreateCollectionInput, UpdateCollectionInput } from "./collections.schema";

// ─────────────────────────────────────────
// Admin queries
// ─────────────────────────────────────────

export async function listCollections(
    db: any,
    options: {
        page?: number;
        limit?: number;
        search?: string;
        showTrashed?: boolean;
        sort?: "name" | "type" | "isActive" | "updatedAt" | "sortOrder";
        order?: "asc" | "desc";
    } = {},
) {
    const {
        page = 1,
        limit = 20,
        search = "",
        showTrashed = false,
        sort = "sortOrder",
        order = "asc",
    } = options;

    const whereConditions: any[] = [];
    if (showTrashed) {
        whereConditions.push(isNotNull(collections.deletedAt));
    } else {
        whereConditions.push(isNull(collections.deletedAt));
    }
    if (search) {
        whereConditions.push(like(collections.name, `%${search}%`));
    }

    const whereClause = whereConditions.length > 0 ? and(...whereConditions) : undefined;
    const offset = (page - 1) * limit;

    const total = await db
        .select({ count: sql`count(*)` })
        .from(collections)
        .where(whereClause)
        .then((rows: any[]) => Number(rows[0]?.count || 0));

    const sortColumn = (() => {
        switch (sort) {
            case "name": return collections.name;
            case "type": return collections.type;
            case "isActive": return collections.isActive;
            case "updatedAt": return collections.updatedAt;
            default: return collections.sortOrder;
        }
    })();

    const data = await db
        .select()
        .from(collections)
        .where(whereClause)
        .orderBy(order === "desc" ? desc(sortColumn) : asc(sortColumn))
        .limit(limit)
        .offset(offset);

    return {
        data,
        pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
        },
    };
}

export async function getCollectionById(db: any, id: string) {
    return db
        .select()
        .from(collections)
        .where(and(eq(collections.id, id), isNull(collections.deletedAt)))
        .limit(1)
        .then((rows: any[]) => rows[0] ?? null);
}

// ─────────────────────────────────────────
// Admin mutations
// ─────────────────────────────────────────

export async function createCollection(
    db: any,
    data: CreateCollectionInput,
) {
    const maxSortOrder = await db
        .select({ max: max(collections.sortOrder) })
        .from(collections)
        .where(isNull(collections.deletedAt))
        .then((result: any[]) => (result[0]?.max ?? -1) + 1);

    return db
        .insert(collections)
        .values({
            id: nanoid(),
            name: data.name,
            type: data.type,
            isActive: data.isActive,
            sortOrder: maxSortOrder,
            config: JSON.stringify(data.config),
        })
        .returning()
        .get();
}

export async function updateCollection(
    db: any,
    id: string,
    data: UpdateCollectionInput,
) {
    const updateData: any = { updatedAt: new Date() };
    if (data.name !== undefined) updateData.name = data.name;
    if (data.type !== undefined) updateData.type = data.type;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;
    if (data.config !== undefined) updateData.config = JSON.stringify(data.config);

    return db
        .update(collections)
        .set(updateData)
        .where(eq(collections.id, id))
        .returning()
        .get();
}

export async function deleteCollection(db: any, id: string): Promise<void> {
    const existing = await getCollectionById(db, id);
    if (!existing) throw Object.assign(new Error("Collection not found"), { statusCode: 404 });

    await db
        .update(collections)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(collections.id, id));
}

export async function bulkDeleteCollections(
    db: any,
    ids: string[],
    permanent = false,
): Promise<void> {
    if (permanent) {
        await db.delete(collections).where(inArray(collections.id, ids));
    } else {
        await db
            .update(collections)
            .set({ deletedAt: new Date(), updatedAt: new Date() })
            .where(inArray(collections.id, ids));
    }
}

export async function bulkActivateCollections(db: any, ids: string[]): Promise<void> {
    await db
        .update(collections)
        .set({ isActive: true, updatedAt: new Date() })
        .where(inArray(collections.id, ids));
}

export async function bulkDeactivateCollections(db: any, ids: string[]): Promise<void> {
    await db
        .update(collections)
        .set({ isActive: false, updatedAt: new Date() })
        .where(inArray(collections.id, ids));
}

export async function restoreCollections(db: any, ids: string[]): Promise<void> {
    await db
        .update(collections)
        .set({ deletedAt: null, updatedAt: new Date() })
        .where(inArray(collections.id, ids));
}

export async function reorderCollections(
    db: any,
    items: { id: string; sortOrder: number }[],
): Promise<void> {
    for (const item of items) {
        await db
            .update(collections)
            .set({ sortOrder: item.sortOrder, updatedAt: new Date() })
            .where(eq(collections.id, item.id));
    }
}
