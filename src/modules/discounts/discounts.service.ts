// src/modules/discounts/discounts.service.ts
import {
    discounts,
    discountProducts,
    discountCollections,
    discountUsage,
    DiscountType,
} from "@/db/schema";
import { sql, desc, asc, isNull, and, isNotNull, eq, count, sum, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { ftsMatch } from "@/lib/search/fts5";

export const DiscountService = {
    async list(db: any, options: { page: number; limit: number; search: string; showTrashed: boolean; sort: any; order: any }) {
        const { page, limit, search, showTrashed, sort, order } = options;
        const offset = (page - 1) * limit;

        let conditions = [];
        if (search) {
            const cond = ftsMatch("discounts_fts", "discounts", search);
            if (cond) conditions.push(cond);
        }
        if (showTrashed) {
            conditions.push(isNotNull(discounts.deletedAt));
        } else {
            conditions.push(isNull(discounts.deletedAt));
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

        const discountIds = results.map((d: any) => d.id);
        let relatedProducts: Record<string, { buy: string[]; get: string[] }> = {};
        let relatedCollections: Record<string, { buy: string[]; get: string[] }> = {};
        let usageStats: Record<string, { count: number; total: number }> = {};

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

            usageResults.forEach((result: any) => {
                usageStats[result.discountId] = {
                    count: result.count ? parseInt(String(result.count), 10) : 0,
                    total: result.total ? parseFloat(String(result.total)) : 0,
                };
            });

            productsResult.forEach((dp: any) => {
                if (!relatedProducts[dp.discountId]) relatedProducts[dp.discountId] = { buy: [], get: [] };
                relatedProducts[dp.discountId][dp.applicationType as 'buy' | 'get'].push(dp.productId);
            });
            collectionsResult.forEach((dc: any) => {
                if (!relatedCollections[dc.discountId]) relatedCollections[dc.discountId] = { buy: [], get: [] };
                relatedCollections[dc.discountId][dc.applicationType as 'buy' | 'get'].push(dc.collectionId);
            });
        }

        const formattedResults = results.map((discount: any) => {
            const stats = usageStats[discount.id] || { count: 0, total: 0 };
            return {
                ...discount,
                createdAt: discount.createdAt ? new Date(Number(discount.createdAt) * 1000).toISOString() : null,
                updatedAt: discount.updatedAt ? new Date(Number(discount.updatedAt) * 1000).toISOString() : null,
                deletedAt: discount.deletedAt ? new Date(Number(discount.deletedAt) * 1000).toISOString() : null,
                startDate: discount.startDate ? new Date(Number(discount.startDate) * 1000).toISOString() : null,
                endDate: discount.endDate ? new Date(Number(discount.endDate) * 1000).toISOString() : null,
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
    },

    async getById(db: any, id: string) {
        const discount = await db.select().from(discounts).where(eq(discounts.id, id)).get();
        if (!discount) return null;

        const productsResult = await db.select().from(discountProducts).where(eq(discountProducts.discountId, id));
        const collectionsResult = await db.select().from(discountCollections).where(eq(discountCollections.discountId, id));

        const relatedProducts: { buy: string[]; get: string[] } = { buy: [], get: [] };
        const relatedCollections: { buy: string[]; get: string[] } = { buy: [], get: [] };

        productsResult.forEach((dp: any) => relatedProducts[dp.applicationType as 'buy' | 'get'].push(dp.productId));
        collectionsResult.forEach((dc: any) => relatedCollections[dc.applicationType as 'buy' | 'get'].push(dc.collectionId));

        return {
            ...discount,
            createdAt: discount.createdAt ? new Date(Number(discount.createdAt) * 1000).toISOString() : null,
            updatedAt: discount.updatedAt ? new Date(Number(discount.updatedAt) * 1000).toISOString() : null,
            deletedAt: discount.deletedAt ? new Date(Number(discount.deletedAt) * 1000).toISOString() : null,
            startDate: discount.startDate ? new Date(Number(discount.startDate) * 1000).toISOString() : null,
            endDate: discount.endDate ? new Date(Number(discount.endDate) * 1000).toISOString() : null,
            relatedProducts,
            relatedCollections,
        };
    },

    async create(db: any, data: any) {
        const existingCode = await db
            .select({ id: discounts.id })
            .from(discounts)
            .where(and(eq(discounts.code, data.code), isNull(discounts.deletedAt)))
            .get();

        if (existingCode) {
            const error = new Error("A discount with this code already exists");
            (error as any).statusCode = 400;
            throw error;
        }

        const discountId = "disc_" + nanoid();
        const productsToInsert: any[] = [];
        const collectionsToInsert: any[] = [];

        if (data.type === DiscountType.AMOUNT_OFF_PRODUCTS) {
            (data.appliesToProducts || []).forEach((productId: string) =>
                productsToInsert.push({ id: "dp_" + nanoid(), discountId, productId, applicationType: "get" })
            );
            (data.appliesToCollections || []).forEach((collectionId: string) =>
                collectionsToInsert.push({ id: "dc_" + nanoid(), discountId, collectionId, applicationType: "get" })
            );
        }

        const batchOps: any[] = [
            db.insert(discounts).values({
                id: discountId,
                code: data.code,
                type: data.type,
                valueType: data.valueType,
                discountValue: data.discountValue,
                minPurchaseAmount: data.minPurchaseAmount,
                minQuantity: data.minQuantity,
                maxUsesPerOrder: data.maxUsesPerOrder,
                maxUses: data.maxUses,
                limitOnePerCustomer: data.limitOnePerCustomer,
                combineWithProductDiscounts: data.combineWithProductDiscounts,
                combineWithOrderDiscounts: data.combineWithOrderDiscounts,
                combineWithShippingDiscounts: data.combineWithShippingDiscounts,
                customerSegment: data.customerSegment,
                startDate: sql`unixepoch(${data.startDate.toISOString()})`,
                endDate: data.endDate ? sql`unixepoch(${data.endDate.toISOString()})` : null,
                isActive: data.isActive,
                createdAt: sql`unixepoch()`,
                updatedAt: sql`unixepoch()`,
            }),
        ];

        if (productsToInsert.length > 0) batchOps.push(db.insert(discountProducts).values(productsToInsert));
        if (collectionsToInsert.length > 0) batchOps.push(db.insert(discountCollections).values(collectionsToInsert));

        await db.batch(batchOps as any);
        return { id: discountId };
    },

    async update(db: any, id: string, data: any) {
        const existingDiscount = await db.select({ id: discounts.id }).from(discounts).where(eq(discounts.id, id)).get();
        if (!existingDiscount) {
            const error = new Error("Discount not found");
            (error as any).statusCode = 404;
            throw error;
        }

        const existingCode = await db
            .select({ id: discounts.id })
            .from(discounts)
            .where(and(eq(discounts.code, data.code), sql`${discounts.id} != ${id}`, isNull(discounts.deletedAt)))
            .get();

        if (existingCode) {
            const error = new Error("A discount with this code already exists");
            (error as any).statusCode = 400;
            throw error;
        }

        const currentTimestamp = Math.floor(Date.now() / 1000);
        let startDateTimestamp: number;
        if (data.startDate instanceof Date && !isNaN(data.startDate.getTime())) {
            startDateTimestamp = Math.floor(data.startDate.getTime() / 1000);
        } else {
            const dt = await db.select({ startDate: discounts.startDate }).from(discounts).where(eq(discounts.id, id)).get();
            startDateTimestamp = typeof dt?.startDate === "number" ? dt.startDate : currentTimestamp;
        }

        let endDateTimestamp: number | null = null;
        if (data.endDate && data.endDate instanceof Date && !isNaN(data.endDate.getTime())) {
            endDateTimestamp = Math.floor(data.endDate.getTime() / 1000);
        }

        const productsToInsert: any[] = [];
        const collectionsToInsert: any[] = [];

        if (data.type === DiscountType.AMOUNT_OFF_PRODUCTS) {
            (data.appliesToProducts || []).forEach((productId: string) =>
                productsToInsert.push({ id: "dp_" + nanoid(), discountId: id, productId, applicationType: "get" })
            );
            (data.appliesToCollections || []).forEach((collectionId: string) =>
                collectionsToInsert.push({ id: "dc_" + nanoid(), discountId: id, collectionId, applicationType: "get" })
            );
        }

        const batchOps: any[] = [
            db.update(discounts).set({
                code: data.code,
                type: data.type,
                valueType: data.valueType,
                discountValue: data.discountValue,
                minPurchaseAmount: data.minPurchaseAmount,
                minQuantity: data.minQuantity,
                maxUsesPerOrder: data.maxUsesPerOrder,
                maxUses: data.maxUses,
                limitOnePerCustomer: data.limitOnePerCustomer,
                combineWithProductDiscounts: data.combineWithProductDiscounts,
                combineWithOrderDiscounts: data.combineWithOrderDiscounts,
                combineWithShippingDiscounts: data.combineWithShippingDiscounts,
                customerSegment: data.customerSegment,
                startDate: sql`${startDateTimestamp}`,
                endDate: endDateTimestamp !== null ? sql`${endDateTimestamp}` : null,
                isActive: data.isActive,
                updatedAt: sql`${currentTimestamp}`,
            }).where(eq(discounts.id, id)),
            db.delete(discountProducts).where(eq(discountProducts.discountId, id)),
            db.delete(discountCollections).where(eq(discountCollections.discountId, id)),
        ];

        if (productsToInsert.length > 0) batchOps.push(db.insert(discountProducts).values(productsToInsert));
        if (collectionsToInsert.length > 0) batchOps.push(db.insert(discountCollections).values(collectionsToInsert));

        await db.batch(batchOps as any);
        return { success: true };
    },

    async delete(db: any, id: string) {
        await db.update(discounts).set({ deletedAt: sql`unixepoch()` }).where(eq(discounts.id, id));
    },

    async bulkDelete(db: any, discountIds: string[], permanent: boolean = false) {
        if (permanent) {
            await db.delete(discounts).where(inArray(discounts.id, discountIds));
        } else {
            await db.update(discounts).set({ deletedAt: sql`unixepoch()` }).where(inArray(discounts.id, discountIds));
        }
    },

    async restore(db: any, discountIds: string[]) {
        await db.update(discounts).set({ deletedAt: null }).where(inArray(discounts.id, discountIds));
    },

    async permanentlyDelete(db: any, id: string) {
        await db.delete(discounts).where(eq(discounts.id, id));
    }
};
