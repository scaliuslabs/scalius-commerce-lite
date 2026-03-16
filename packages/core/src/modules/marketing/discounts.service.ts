// src/modules/marketing/discounts.service.ts
// Admin discount query service.
// Extracted from src/lib/admin.ts.

import { db } from "@scalius/database/client";
import { discounts, discountUsage } from "@scalius/database/schema";
import { and, sql, desc, eq, asc } from "drizzle-orm";
import { ftsMatch } from "../../search/fts5";
import type { Discount } from "@scalius/database/schema";

/**
 * Returns a paginated, searchable list of discount codes for the admin dashboard.
 * Includes usage counts and total discounted amounts.
 */
export async function getDiscounts(options: {
    search?: string;
    type?: string;
    page?: number;
    limit?: number;
    showTrashed?: boolean;
    sort?:
    | "code"
    | "type"
    | "value"
    | "startDate"
    | "endDate"
    | "createdAt"
    | "updatedAt";
    order?: "asc" | "desc";
}) {
    const {
        search,
        type,
        page = 1,
        limit = 10,
        showTrashed = false,
        sort = "updatedAt",
        order = "desc",
    } = options;
    const offset = (page - 1) * limit;

    const whereConditions = [];

    if (showTrashed) {
        whereConditions.push(sql`${discounts.deletedAt} IS NOT NULL`);
    } else {
        whereConditions.push(sql`${discounts.deletedAt} IS NULL`);
    }

    if (search) {
        const cond = ftsMatch("discounts_fts", "discounts", search);
        if (cond) whereConditions.push(cond);
    }

    if (type) {
        whereConditions.push(eq(discounts.type, type as Discount["type"]));
    }

    const countArr = await db
        .select({ count: sql<number>`count(distinct ${discounts.id})` })
        .from(discounts)
        .where(whereConditions.length > 0 ? and(...whereConditions) : undefined);
    const count = countArr[0]?.count ?? 0;

    const results = await db
        .select({
            id: discounts.id,
            code: discounts.code,
            type: discounts.type,
            valueType: discounts.valueType,
            discountValue: discounts.discountValue,
            minPurchaseAmount: discounts.minPurchaseAmount,
            minQuantity: discounts.minQuantity,
            maxUsesPerOrder: discounts.maxUsesPerOrder,
            maxUses: discounts.maxUses,
            limitOnePerCustomer: discounts.limitOnePerCustomer,
            combineWithProductDiscounts: discounts.combineWithProductDiscounts,
            combineWithOrderDiscounts: discounts.combineWithOrderDiscounts,
            combineWithShippingDiscounts: discounts.combineWithShippingDiscounts,
            customerSegment: discounts.customerSegment,
            startDate: sql<number>`CAST(${discounts.startDate} AS INTEGER)`,
            endDate: sql<number>`CAST(${discounts.endDate} AS INTEGER)`,
            isActive: discounts.isActive,
            createdAt: sql<number>`CAST(${discounts.createdAt} AS INTEGER)`,
            updatedAt: sql<number>`CAST(${discounts.updatedAt} AS INTEGER)`,
            deletedAt: sql<number>`CAST(${discounts.deletedAt} AS INTEGER)`,
            relatedProducts: sql<string>`json_object('buy', '[]', 'get', '[]')`,
            relatedCollections: sql<string>`json_object('buy', '[]', 'get', '[]')`,
        })
        .from(discounts)
        .where(whereConditions.length > 0 ? and(...whereConditions) : undefined)
        .limit(limit)
        .offset(offset)
        .orderBy(
            (() => {
                const sortField = (() => {
                    switch (sort) {
                        case "code":
                            return discounts.code;
                        case "type":
                            return discounts.type;
                        case "value":
                            return discounts.discountValue;
                        case "startDate":
                            return discounts.startDate;
                        case "endDate":
                            return discounts.endDate;
                        case "createdAt":
                            return discounts.createdAt;
                        case "updatedAt":
                        default:
                            return discounts.updatedAt;
                    }
                })();
                return order === "asc" ? asc(sortField) : desc(sortField);
            })(),
        );

    const discountIds = results.map((discount) => discount.id);
    const usageStats: Record<string, { count: number; total: number }> = {};

    if (discountIds.length > 0) {
        const usageResults = await db
            .select({
                discountId: discountUsage.discountId,
                count: sql<number>`CAST(COUNT(${discountUsage.id}) AS INTEGER)`,
                total: sql<number>`CAST(SUM(${discountUsage.amountDiscounted}) AS INTEGER)`,
            })
            .from(discountUsage)
            .where(sql`${discountUsage.discountId} IN ${discountIds}`)
            .groupBy(discountUsage.discountId);

        usageResults.forEach((result) => {
            usageStats[result.discountId] = {
                count: result.count ? parseInt(String(result.count), 10) : 0,
                total: result.total ? parseFloat(String(result.total)) : 0,
            };
        });
    }

    const formattedDiscounts = results.map((discount) => {
        const stats = usageStats[discount.id] || { count: 0, total: 0 };

        return {
            ...discount,
            startDate: discount.startDate
                ? new Date(discount.startDate * 1000).toISOString()
                : null,
            endDate: discount.endDate
                ? new Date(discount.endDate * 1000).toISOString()
                : null,
            createdAt: discount.createdAt
                ? new Date(discount.createdAt * 1000).toISOString()
                : null,
            updatedAt: discount.updatedAt
                ? new Date(discount.updatedAt * 1000).toISOString()
                : null,
            deletedAt: discount.deletedAt
                ? new Date(discount.deletedAt * 1000).toISOString()
                : null,
            relatedProducts: JSON.parse(
                discount.relatedProducts || '{"buy": [], "get": []}',
            ),
            relatedCollections: JSON.parse(
                discount.relatedCollections || '{"buy": [], "get": []}',
            ),
            usageCount: stats.count,
            totalDiscountAmount: stats.total,
        };
    });

    return {
        discounts: formattedDiscounts,
        pagination: {
            total: count,
            page,
            limit,
            totalPages: Math.ceil(count / limit),
        },
    };
}
