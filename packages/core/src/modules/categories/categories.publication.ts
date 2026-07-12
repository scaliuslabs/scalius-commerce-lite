import { categories, products } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { buildBatchGuard } from "@scalius/database/client";
import { and, eq, isNull, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { publicProductBaseConditions } from "../products/products.public-eligibility";

export const CATEGORY_PUBLISH_NOT_READY = "CATEGORY_PUBLISH_NOT_READY";

export type CategoryPublishReadiness = {
    ready: boolean;
    eligibleProductCount: number;
    blockers: Array<{ code: "no_buyer_resolvable_products"; message: string }>;
    warnings: Array<{
        code: "missing_image" | "missing_description" | "missing_meta_description";
        message: string;
    }>;
};

export function publicCategoryConditions(): SQL[] {
    return [
        eq(categories.status, "published"),
        isNull(categories.deletedAt),
    ];
}

export function buyerResolvableCategoryProductExists(categoryId: SQLWrapper | string): SQL {
    return sql`EXISTS (
        SELECT 1
        FROM ${products}
        WHERE ${and(
            eq(products.categoryId, categoryId),
            ...publicProductBaseConditions(),
        )}
    )`;
}

export function publishedCategoryIdExists(categoryId: SQLWrapper | string): SQL {
    return sql`EXISTS (
        SELECT 1
        FROM ${categories}
        WHERE ${categories.id} = ${categoryId}
          AND ${and(...publicCategoryConditions())}
    )`;
}

export async function getCategoryPublishReadiness(
    db: Database,
    categoryId: string,
): Promise<CategoryPublishReadiness | null> {
    const row = await db
        .select({
            imageUrl: categories.imageUrl,
            description: categories.description,
            metaDescription: categories.metaDescription,
            eligibleProductCount: sql<number>`(
                SELECT count(*)
                FROM ${products}
                WHERE ${and(
                    eq(products.categoryId, categoryId),
                    ...publicProductBaseConditions(),
                )}
            )`,
        })
        .from(categories)
        .where(eq(categories.id, categoryId))
        .get();

    if (!row) return null;
    const eligibleProductCount = Number(row.eligibleProductCount ?? 0);
    const blockers: CategoryPublishReadiness["blockers"] = eligibleProductCount > 0
        ? []
        : [{
            code: "no_buyer_resolvable_products",
            message: "Add at least one active product with a buyer-resolvable SKU before publishing.",
        }];
    const warnings: CategoryPublishReadiness["warnings"] = [];
    if (!row.imageUrl?.trim()) {
        warnings.push({ code: "missing_image", message: "Add an image for richer category navigation and sharing." });
    }
    if (!row.description?.trim()) {
        warnings.push({ code: "missing_description", message: "Add a buyer-facing category description." });
    }
    if (!row.metaDescription?.trim()) {
        warnings.push({ code: "missing_meta_description", message: "Add a search description for stronger discovery copy." });
    }

    return {
        ready: blockers.length === 0,
        eligibleProductCount,
        blockers,
        warnings,
    };
}

export function buildCategoryPublishReadyGuard(
    db: Database,
    categoryId: string,
): BatchItem<"sqlite"> {
    return buildBatchGuard(db, sql`
        CASE WHEN ${buyerResolvableCategoryProductExists(categoryId)}
        THEN 1 ELSE json_extract(${CATEGORY_PUBLISH_NOT_READY}, '$') END
    `);
}
