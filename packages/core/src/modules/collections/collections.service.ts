// src/modules/collections/collections.service.ts
// All DB queries and business logic for the collections domain.

import { collections } from "@scalius/database/schema";
import { sql, and, isNull, isNotNull, eq, inArray, like, asc, desc, max, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { CreateCollectionInput, UpdateCollectionInput } from "./collections.schema";
import type { Database } from "@scalius/database/client";
import { NotFoundError } from "@scalius/core/errors";

// ─────────────────────────────────────────
// Admin queries
// ─────────────────────────────────────────

export async function listCollections(
    db: Database,
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

    const whereConditions: (SQL | undefined)[] = [];
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
        .then((rows: { count: unknown }[]) => Number(rows[0]?.count || 0));

    const sortColumn = (() => {
        switch (sort) {
            case "name": return collections.name;
            case "type": return collections.type;
            case "isActive": return collections.isActive;
            case "updatedAt": return collections.updatedAt;
            default: return collections.sortOrder;
        }
    })();

    const items = await db
        .select()
        .from(collections)
        .where(whereClause)
        .orderBy(order === "desc" ? desc(sortColumn) : asc(sortColumn))
        .limit(limit)
        .offset(offset);

    return {
        collections: items,
        pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
        },
    };
}

export async function getCollectionById(db: Database, id: string) {
    return db
        .select()
        .from(collections)
        .where(and(eq(collections.id, id), isNull(collections.deletedAt)))
        .limit(1)
        .then((rows: (typeof collections.$inferSelect)[]) => rows[0] ?? null);
}

// ─────────────────────────────────────────
// Admin mutations
// ─────────────────────────────────────────

export async function createCollection(
    db: Database,
    data: CreateCollectionInput,
) {
    const maxSortOrder = await db
        .select({ max: max(collections.sortOrder) })
        .from(collections)
        .where(isNull(collections.deletedAt))
        .then((result: { max: number | null }[]) => (result[0]?.max ?? -1) + 1);

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
    db: Database,
    id: string,
    data: UpdateCollectionInput,
) {
    const updateData: Partial<typeof collections.$inferInsert> & { updatedAt: Date } = { updatedAt: new Date() };
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

export async function deleteCollection(db: Database, id: string): Promise<void> {
    const existing = await getCollectionById(db, id);
    if (!existing) throw new NotFoundError("Collection not found");

    await db
        .update(collections)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(collections.id, id));
}

export async function bulkDeleteCollections(
    db: Database,
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

export async function bulkActivateCollections(db: Database, ids: string[]): Promise<void> {
    await db
        .update(collections)
        .set({ isActive: true, updatedAt: new Date() })
        .where(inArray(collections.id, ids));
}

export async function bulkDeactivateCollections(db: Database, ids: string[]): Promise<void> {
    await db
        .update(collections)
        .set({ isActive: false, updatedAt: new Date() })
        .where(inArray(collections.id, ids));
}

export async function restoreCollections(db: Database, ids: string[]): Promise<void> {
    await db
        .update(collections)
        .set({ deletedAt: null, updatedAt: new Date() })
        .where(inArray(collections.id, ids));
}

export async function reorderCollections(
    db: Database,
    items: { id: string; sortOrder: number }[],
): Promise<void> {
    for (const item of items) {
        await db
            .update(collections)
            .set({ sortOrder: item.sortOrder, updatedAt: new Date() })
            .where(eq(collections.id, item.id));
    }
}
