// src/modules/discounts/discounts.service.ts
import {
    discounts,
    discountProducts,
    discountCollections,
    discountUsage,
    DiscountType,
} from "@scalius/database/schema";
import { sql, desc, asc, isNull, and, isNotNull, eq, count, sum, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { ftsMatch } from "../../search/fts5";
import type { Database } from "@scalius/database/client";
import { NotFoundError, ConflictError } from "@scalius/core/errors";
import type { CreateDiscountInput, UpdateDiscountInput } from "./discounts.validation";

export async function listDiscounts(db: Database, options: { page: number; limit: number; search: string; showTrashed: boolean; sort: string; order: "asc" | "desc"; type?: DiscountType }) {
    const { page, limit: rawLimit, search, showTrashed, sort, order, type } = options;
    const limit = Math.min(Math.max(rawLimit || 10, 1), 100);
    const offset = (page - 1) * limit;

    const conditions = [];
    if (search) {
        const cond = ftsMatch("discounts_fts", "discounts", search);
        if (cond) conditions.push(cond);
    }
    if (showTrashed) {
        conditions.push(isNotNull(discounts.deletedAt));
    } else {
        conditions.push(isNull(discounts.deletedAt));
    }
    if (type) {
        conditions.push(eq(discounts.type, type));
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const totalResult = await db.select({ count: sql<number>`count(*)` }).from(discounts).where(whereClause).get();
    const total = totalResult?.count || 0;

    const sortField =
        sort === "code"
            ? discounts.code
            : sort === "type"
                ? discounts.type
                : sort === "value"
                    ? discounts.discountValue
                    : sort === "startDate"
                        ? discounts.startDate
                        : sort === "endDate"
                            ? discounts.endDate
                            : sort === "createdAt"
                                ? discounts.createdAt
                                : discounts.updatedAt;

    const sortOrder = order === "asc" ? asc(sortField) : desc(sortField);

    const results = await db
        .select()
        .from(discounts)
        .where(whereClause)
        .orderBy(sortOrder)
        .limit(limit)
        .offset(offset);

    const discountIds = results.map((d) => d.id);
    const relatedProducts: Record<string, { buy: string[]; get: string[] }> = {};
    const relatedCollections: Record<string, { buy: string[]; get: string[] }> = {};
    const usageStats: Record<string, { count: number; total: number }> = {};

    if (discountIds.length > 0) {
        const productsResult = await db
            .select()
            .from(discountProducts)
            .where(inArray(discountProducts.discountId, discountIds));

        const collectionsResult = await db
            .select()
            .from(discountCollections)
            .where(inArray(discountCollections.discountId, discountIds));

        const usageResults = await db
            .select({
                discountId: discountUsage.discountId,
                count: count(discountUsage.id),
                total: sum(discountUsage.amountDiscounted),
            })
            .from(discountUsage)
            .where(inArray(discountUsage.discountId, discountIds))
            .groupBy(discountUsage.discountId);

        usageResults.forEach((result) => {
            usageStats[result.discountId] = {
                count: result.count ? parseInt(String(result.count), 10) : 0,
                total: result.total ? parseFloat(String(result.total)) : 0,
            };
        });

        productsResult.forEach((dp) => {
            if (!relatedProducts[dp.discountId]) relatedProducts[dp.discountId] = { buy: [], get: [] };
            const prodEntry = relatedProducts[dp.discountId];
            if (prodEntry) prodEntry[dp.applicationType as 'buy' | 'get'].push(dp.productId);
        });
        collectionsResult.forEach((dc) => {
            if (!relatedCollections[dc.discountId]) relatedCollections[dc.discountId] = { buy: [], get: [] };
            const collEntry = relatedCollections[dc.discountId];
            if (collEntry) collEntry[dc.applicationType as 'buy' | 'get'].push(dc.collectionId);
        });
    }

    // Drizzle's mode:"timestamp" already converts the raw integer (unix seconds)
    // to a Date object via mapFromDriverValue. We just need .toISOString().
    // Do NOT do `new Date(Number(date) * 1000)` — that double-converts and
    // produces dates in year 58196.
    const formattedResults = results.map((discount) => {
        const stats = usageStats[discount.id] || { count: 0, total: 0 };
        return {
            ...discount,
            createdAt: discount.createdAt instanceof Date ? discount.createdAt.toISOString() : null,
            updatedAt: discount.updatedAt instanceof Date ? discount.updatedAt.toISOString() : null,
            deletedAt: discount.deletedAt instanceof Date ? discount.deletedAt.toISOString() : null,
            startDate: discount.startDate instanceof Date ? discount.startDate.toISOString() : null,
            endDate: discount.endDate instanceof Date ? discount.endDate.toISOString() : null,
            relatedProducts: relatedProducts[discount.id] || { buy: [], get: [] },
            relatedCollections: relatedCollections[discount.id] || { buy: [], get: [] },
            usageCount: stats.count,
            totalDiscountAmount: stats.total,
        };
    });

    const totalPages = Math.ceil(total / limit);

    return {
        discounts: formattedResults,
        pagination: { total, page, limit, totalPages },
    };
}

export async function getDiscountById(db: Database, id: string) {
    const discount = await db.select().from(discounts).where(eq(discounts.id, id)).get();
    if (!discount) return null;

    const productsResult = await db.select().from(discountProducts).where(eq(discountProducts.discountId, id));
    const collectionsResult = await db.select().from(discountCollections).where(eq(discountCollections.discountId, id));

    const relatedProducts: { buy: string[]; get: string[] } = { buy: [], get: [] };
    const relatedCollections: { buy: string[]; get: string[] } = { buy: [], get: [] };

    productsResult.forEach((dp) => relatedProducts[dp.applicationType as 'buy' | 'get'].push(dp.productId));
    collectionsResult.forEach((dc) => relatedCollections[dc.applicationType as 'buy' | 'get'].push(dc.collectionId));

    return {
        ...discount,
        createdAt: discount.createdAt instanceof Date ? discount.createdAt.toISOString() : null,
        updatedAt: discount.updatedAt instanceof Date ? discount.updatedAt.toISOString() : null,
        deletedAt: discount.deletedAt instanceof Date ? discount.deletedAt.toISOString() : null,
        startDate: discount.startDate instanceof Date ? discount.startDate.toISOString() : null,
        endDate: discount.endDate instanceof Date ? discount.endDate.toISOString() : null,
        relatedProducts,
        relatedCollections,
    };
}

export async function createDiscount(db: Database, data: CreateDiscountInput) {
    // Codes are stored uppercase (normalized by validation schema),
    // but ensure uppercase here too for the uniqueness check.
    const code = (data.code as string).toUpperCase();
    const existingCode = await db
        .select({ id: discounts.id })
        .from(discounts)
        .where(and(eq(discounts.code, code), isNull(discounts.deletedAt)))
        .get();

    if (existingCode) {
        throw new ConflictError("A discount with this code already exists");
    }

    const discountId = "disc_" + nanoid();
    const productsToInsert: { id: string; discountId: string; productId: string; applicationType: "get" }[] = [];
    const collectionsToInsert: { id: string; discountId: string; collectionId: string; applicationType: "get" }[] = [];

    if (data.type === DiscountType.AMOUNT_OFF_PRODUCTS) {
        ((data.appliesToProducts || []) as string[]).forEach((productId: string) =>
            productsToInsert.push({ id: "dp_" + nanoid(), discountId, productId, applicationType: "get" })
        );
        ((data.appliesToCollections || []) as string[]).forEach((collectionId: string) =>
            collectionsToInsert.push({ id: "dc_" + nanoid(), discountId, collectionId, applicationType: "get" })
        );
    }

    const startDate = data.startDate as Date;
    const endDate = data.endDate as Date | null;

    // Drizzle D1 batch() requires specific tuple types
    const batchOps: unknown[] = [
        db.insert(discounts).values({
            id: discountId,
            code,
            type: data.type as typeof discounts.$inferInsert.type,
            valueType: data.valueType as typeof discounts.$inferInsert.valueType,
            discountValue: data.discountValue as number,
            minPurchaseAmount: data.minPurchaseAmount as number | undefined,
            minQuantity: data.minQuantity as number | undefined,
            maxUsesPerOrder: data.maxUsesPerOrder as number | undefined,
            maxUses: data.maxUses as number | undefined,
            limitOnePerCustomer: data.limitOnePerCustomer as boolean | undefined,
            combineWithProductDiscounts: data.combineWithProductDiscounts as boolean | undefined,
            combineWithOrderDiscounts: data.combineWithOrderDiscounts as boolean | undefined,
            combineWithShippingDiscounts: data.combineWithShippingDiscounts as boolean | undefined,
            customerSegment: data.customerSegment as string | undefined,
            startDate: sql`unixepoch(${startDate.toISOString()})`,
            endDate: endDate ? sql`unixepoch(${endDate.toISOString()})` : null,
            isActive: data.isActive as boolean,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        }),
    ];

    if (productsToInsert.length > 0) batchOps.push(db.insert(discountProducts).values(productsToInsert));
    if (collectionsToInsert.length > 0) batchOps.push(db.insert(discountCollections).values(collectionsToInsert));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
    await db.batch(batchOps as any);
    return { id: discountId };
}

export async function updateDiscount(db: Database, id: string, data: UpdateDiscountInput) {
    const existingDiscount = await db.select({ id: discounts.id }).from(discounts).where(eq(discounts.id, id)).get();
    if (!existingDiscount) {
        throw new NotFoundError("Discount not found");
    }

    const code = (data.code as string).toUpperCase();
    const existingCode = await db
        .select({ id: discounts.id })
        .from(discounts)
        .where(and(eq(discounts.code, code), sql`${discounts.id} != ${id}`, isNull(discounts.deletedAt)))
        .get();

    if (existingCode) {
        throw new ConflictError("A discount with this code already exists");
    }

    const currentTimestamp = Math.floor(Date.now() / 1000);
    let startDateTimestamp: number;
    if (data.startDate instanceof Date && !isNaN((data.startDate as Date).getTime())) {
        startDateTimestamp = Math.floor((data.startDate as Date).getTime() / 1000);
    } else {
        const dt = await db.select({ startDate: discounts.startDate }).from(discounts).where(eq(discounts.id, id)).get();
        startDateTimestamp = typeof dt?.startDate === "number" ? dt.startDate : currentTimestamp;
    }

    let endDateTimestamp: number | null = null;
    if (data.endDate && data.endDate instanceof Date && !isNaN((data.endDate as Date).getTime())) {
        endDateTimestamp = Math.floor((data.endDate as Date).getTime() / 1000);
    }

    const productsToInsert: { id: string; discountId: string; productId: string; applicationType: "get" }[] = [];
    const collectionsToInsert: { id: string; discountId: string; collectionId: string; applicationType: "get" }[] = [];

    if (data.type === DiscountType.AMOUNT_OFF_PRODUCTS) {
        ((data.appliesToProducts || []) as string[]).forEach((productId: string) =>
            productsToInsert.push({ id: "dp_" + nanoid(), discountId: id, productId, applicationType: "get" })
        );
        ((data.appliesToCollections || []) as string[]).forEach((collectionId: string) =>
            collectionsToInsert.push({ id: "dc_" + nanoid(), discountId: id, collectionId, applicationType: "get" })
        );
    }

    // Drizzle D1 batch() requires specific tuple types
    const batchOps: unknown[] = [
        db.update(discounts).set({
            code,
            type: data.type as typeof discounts.$inferInsert.type,
            valueType: data.valueType as typeof discounts.$inferInsert.valueType,
            discountValue: data.discountValue as number,
            minPurchaseAmount: data.minPurchaseAmount as number | undefined,
            minQuantity: data.minQuantity as number | undefined,
            maxUsesPerOrder: data.maxUsesPerOrder as number | undefined,
            maxUses: data.maxUses as number | undefined,
            limitOnePerCustomer: data.limitOnePerCustomer as boolean | undefined,
            combineWithProductDiscounts: data.combineWithProductDiscounts as boolean | undefined,
            combineWithOrderDiscounts: data.combineWithOrderDiscounts as boolean | undefined,
            combineWithShippingDiscounts: data.combineWithShippingDiscounts as boolean | undefined,
            customerSegment: data.customerSegment as string | undefined,
            startDate: sql`${startDateTimestamp}`,
            endDate: endDateTimestamp !== null ? sql`${endDateTimestamp}` : null,
            isActive: data.isActive as boolean,
            updatedAt: sql`${currentTimestamp}`,
        }).where(eq(discounts.id, id)),
        db.delete(discountProducts).where(eq(discountProducts.discountId, id)),
        db.delete(discountCollections).where(eq(discountCollections.discountId, id)),
    ];

    if (productsToInsert.length > 0) batchOps.push(db.insert(discountProducts).values(productsToInsert));
    if (collectionsToInsert.length > 0) batchOps.push(db.insert(discountCollections).values(collectionsToInsert));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
    await db.batch(batchOps as any);
    return { id };
}

export async function deleteDiscount(db: Database, id: string) {
    await db.update(discounts).set({ deletedAt: sql`unixepoch()` }).where(eq(discounts.id, id));
}

export async function bulkDeleteDiscounts(db: Database, discountIds: string[], permanent: boolean = false) {
    if (permanent) {
        await db.delete(discounts).where(inArray(discounts.id, discountIds));
    } else {
        await db.update(discounts).set({ deletedAt: sql`unixepoch()` }).where(inArray(discounts.id, discountIds));
    }
}

export async function restoreDiscounts(db: Database, discountIds: string[]) {
    // Check for code conflicts before restoring: ensure no active discount
    // already uses any of the codes that would be restored
    const toRestore = await db
        .select({ id: discounts.id, code: discounts.code })
        .from(discounts)
        .where(inArray(discounts.id, discountIds));

    for (const disc of toRestore) {
        const conflict = await db
            .select({ id: discounts.id })
            .from(discounts)
            .where(and(
                eq(discounts.code, disc.code),
                isNull(discounts.deletedAt),
                sql`${discounts.id} != ${disc.id}`,
            ))
            .get();

        if (conflict) {
            throw new ConflictError(`Cannot restore discount "${disc.code}": an active discount with this code already exists`);
        }
    }

    await db.update(discounts).set({ deletedAt: null }).where(inArray(discounts.id, discountIds));
}

export async function permanentlyDeleteDiscount(db: Database, id: string) {
    await db.delete(discounts).where(eq(discounts.id, id));
}
