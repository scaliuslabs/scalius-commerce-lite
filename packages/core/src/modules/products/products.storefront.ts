// src/modules/products/products.storefront.ts
// Storefront product queries — public-facing read-only operations.
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@scalius/database/schema";
import {
    products,
    categories,
    productVariants,
    productImages,
    productRichContent,
    productAttributeValues,
    productAttributes,
} from "@scalius/database/schema";
import { and, sql, desc, eq, asc, isNull, inArray, or, type SQL } from "drizzle-orm";
import { ftsMatch } from "../../search/fts5";
import { unixToDate } from "@scalius/shared/utils";
import { calculateDiscountedPrice } from "@scalius/shared/price-utils";
import type { StorefrontProductFilterInput } from "./products.types";

// ─────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────

function extractFeatures(description: string | null): string[] {
    if (!description) return [];
    const features: string[] = [];
    const lines = description.split("\n");
    for (const line of lines) {
        if (line.trim().match(/^[-*•]|^\d+\./) && line.trim().length > 2) {
            features.push(line.trim().replace(/^[-*•]|^\d+\./, "").trim());
        }
    }
    return features;
}

// ─────────────────────────────────────────
// Storefront queries
// ─────────────────────────────────────────

/**
 * Returns a paginated list of active storefront products with images and categories.
 * This is the unified query backing the Hono GET /api/storefront/products route.
 */
export async function getStorefrontProducts(db: DrizzleD1Database<typeof schema>, params: StorefrontProductFilterInput) {
    const {
        category,
        search,
        page = 1,
        limit = 20,
        sort = "newest",
        minPrice,
        maxPrice,
        freeDelivery,
        hasDiscount,
        ids,
        attributeFilters = [],
    } = params;

    const conditions: (SQL | undefined)[] = [
        eq(products.isActive, true),
        isNull(products.deletedAt),
    ];

    if (category) conditions.push(eq(products.categoryId, category));
    if (search) {
        const cond = ftsMatch("products_fts", "products", search);
        if (cond) conditions.push(cond);
    }
    if (minPrice !== undefined) conditions.push(sql`${products.price} >= ${minPrice}`);
    if (maxPrice !== undefined) conditions.push(sql`${products.price} <= ${maxPrice}`);
    if (freeDelivery === "true") conditions.push(eq(products.freeDelivery, true));
    else if (freeDelivery === "false") conditions.push(eq(products.freeDelivery, false));
    if (hasDiscount === "true") conditions.push(sql`(${products.discountPercentage} > 0 OR ${products.discountAmount} > 0)`);
    else if (hasDiscount === "false") conditions.push(sql`(${products.discountPercentage} IS NULL OR ${products.discountPercentage} = 0) AND (${products.discountAmount} IS NULL OR ${products.discountAmount} = 0)`);
    if (ids) {
        const productIds = ids.split(",");
        conditions.push(inArray(products.id, productIds));
    }

    let orderBy: SQL | ReturnType<typeof desc> | typeof products.name;
    const effectivePriceSql = sql`CASE
        WHEN ${products.discountType} = 'flat' AND ${products.discountAmount} > 0 THEN MAX(${products.price} - ${products.discountAmount}, 0)
        WHEN ${products.discountPercentage} > 0 THEN ROUND(${products.price} * (1 - ${products.discountPercentage} / 100.0))
        ELSE ${products.price}
    END`;
    if (sort === "price-asc") {
        orderBy = effectivePriceSql;
    } else if (sort === "price-desc") {
        orderBy = desc(effectivePriceSql);
    } else if (sort === "name-asc") {
        orderBy = products.name;
    } else if (sort === "name-desc") {
        orderBy = desc(products.name);
    } else if (sort === "discount") {
        // Sort by effective savings ratio (higher savings first)
        orderBy = desc(sql`CASE
            WHEN ${products.discountType} = 'flat' AND ${products.discountAmount} > 0 THEN ${products.discountAmount} / ${products.price} * 100
            WHEN ${products.discountPercentage} > 0 THEN ${products.discountPercentage}
            ELSE 0
        END`);
    } else {
        orderBy = desc(products.createdAt);
    }

    const offset = (page - 1) * limit;

    let query = db
        .select({
            id: products.id,
            name: products.name,
            price: products.price,
            slug: products.slug,
            discountType: products.discountType,
            discountPercentage: products.discountPercentage,
            discountAmount: products.discountAmount,
            freeDelivery: products.freeDelivery,
            categoryId: products.categoryId,
            createdAt: sql<number>`CAST(${products.createdAt} AS INTEGER)`.as("createdAt"),
            updatedAt: sql<number>`CAST(${products.updatedAt} AS INTEGER)`.as("updatedAt"),
            variantCount: sql<number>`count(${productVariants.id})`.as("variantCount"),
        })
        .from(products)
        .where(and(...conditions))
        .leftJoin(
            productVariants,
            and(eq(products.id, productVariants.productId), isNull(productVariants.deletedAt)),
        )
        .groupBy(
            products.id, products.name, products.price, products.slug,
            products.discountType, products.discountPercentage, products.discountAmount,
            products.freeDelivery, products.categoryId, products.createdAt, products.updatedAt,
        );

    if (attributeFilters.length > 0) {
        const subquery = db
            .select({ productId: productAttributeValues.productId })
            .from(productAttributeValues)
            .leftJoin(productAttributes, eq(productAttributeValues.attributeId, productAttributes.id))
            .where(
                or(
                    ...attributeFilters.map((filter) =>
                        and(
                            eq(productAttributes.slug, filter.slug),
                            eq(productAttributeValues.value, filter.value),
                        ),
                    ),
                )!,
            )
            .groupBy(productAttributeValues.productId)
            .having(sql`count(*) = ${attributeFilters.length}`)
            .as("filtered_products");

        query = query.innerJoin(subquery, eq(products.id, subquery.productId));
    }

    const productsList = await query.orderBy(orderBy).limit(limit).offset(offset).all();
    const productIds = productsList.map((p) => p.id);

    let imageMap = new Map<string, string>();
    if (productIds.length > 0) {
        const images = await db
            .select({ productId: productImages.productId, url: productImages.url })
            .from(productImages)
            .where(and(eq(productImages.isPrimary, true), inArray(productImages.productId, productIds)))
            .all();
        imageMap = new Map(images.map((img: { productId: string; url: string }) => [img.productId, img.url]));
    }

    let categoryMap = new Map<string, { id: string; name: string; slug: string }>();
    const categoryIds = [...new Set(productsList.map((p) => p.categoryId).filter(Boolean))] as string[];
    if (categoryIds.length > 0) {
        const categoriesData: Array<{ id: string; name: string; slug: string }> = await db
            .select({ id: categories.id, name: categories.name, slug: categories.slug })
            .from(categories)
            .where(inArray(categories.id, categoryIds))
            .all();
        categoryMap = new Map(categoriesData.map((cat) => [cat.id, cat]));
    }

    const productsWithImages = productsList.map(({ variantCount, ...product }: { variantCount: number; id: string; name: string; price: number; slug: string; discountType: string | null; discountPercentage: number | null; discountAmount: number | null; freeDelivery: boolean; categoryId: string | null; createdAt: number; updatedAt: number }) => ({
        ...product,
        hasVariants: variantCount > 0,
        imageUrl: imageMap.get(product.id) || null,
        category: product.categoryId ? categoryMap.get(product.categoryId) || null : null,
        createdAt: unixToDate(product.createdAt)?.toISOString() || null,
        updatedAt: unixToDate(product.updatedAt)?.toISOString() || null,
        discountedPrice: calculateDiscountedPrice(
            product.price, product.discountType,
            product.discountPercentage, product.discountAmount,
        ),
    }));

    // Count query
    let countQuery = db
        .select({ count: sql<number>`count(*)` })
        .from(products)
        .where(and(...conditions));

    if (attributeFilters.length > 0) {
        const countSubquery = db
            .select({ productId: productAttributeValues.productId })
            .from(productAttributeValues)
            .leftJoin(productAttributes, eq(productAttributeValues.attributeId, productAttributes.id))
            .where(
                or(
                    ...attributeFilters.map((filter) =>
                        and(
                            eq(productAttributes.slug, filter.slug),
                            eq(productAttributeValues.value, filter.value),
                        ),
                    ),
                )!,
            )
            .groupBy(productAttributeValues.productId)
            .having(sql`count(*) = ${attributeFilters.length}`)
            .as("count_filtered_products");
        countQuery = countQuery.innerJoin(countSubquery, eq(products.id, countSubquery.productId));
    }

    const totalCount = await countQuery.get();

    return {
        products: productsWithImages,
        pagination: {
            page,
            limit,
            total: totalCount?.count || 0,
            totalPages: Math.ceil((totalCount?.count || 0) / limit),
        },
    };
}

/**
 * Returns full storefront product details (variants, images, attributes, related products)
 * for a single product identified by slug.
 */
export async function getStorefrontProductBySlug(db: DrizzleD1Database<typeof schema>, slug: string) {
    const product = await db
        .select({
            id: products.id,
            name: products.name,
            description: products.description,
            price: products.price,
            categoryId: products.categoryId,
            slug: products.slug,
            metaTitle: products.metaTitle,
            metaDescription: products.metaDescription,
            discountType: products.discountType,
            discountPercentage: products.discountPercentage,
            discountAmount: products.discountAmount,
            freeDelivery: products.freeDelivery,
            isActive: products.isActive,
            deletedAt: sql<number | null>`CAST(${products.deletedAt} AS INTEGER)`,
            createdAt: sql<number>`CAST(${products.createdAt} AS INTEGER)`,
            updatedAt: sql<number>`CAST(${products.updatedAt} AS INTEGER)`,
        })
        .from(products)
        .where(and(eq(products.slug, slug), eq(products.isActive, true), isNull(products.deletedAt)))
        .get();

    if (!product) return null;

    const promises: Promise<{ type: string; data: unknown }>[] = [
        db.select({
            id: productImages.id,
            productId: productImages.productId,
            url: productImages.url,
            alt: productImages.alt,
            isPrimary: productImages.isPrimary,
            sortOrder: productImages.sortOrder,
            createdAt: sql<number>`CAST(${productImages.createdAt} AS INTEGER)`,
        }).from(productImages).where(eq(productImages.productId, product.id)).orderBy(productImages.sortOrder).all()
            .then((res: Array<{ id: string; productId: string; url: string; alt: string | null; isPrimary: boolean; sortOrder: number; createdAt: number }>) => ({ type: "images", data: res })),

        db.select({
            id: productVariants.id,
            productId: productVariants.productId,
            size: productVariants.size,
            color: productVariants.color,
            weight: productVariants.weight,
            sku: productVariants.sku,
            price: productVariants.price,
            stock: productVariants.stock,
            reservedStock: productVariants.reservedStock,
            barcode: productVariants.barcode,
            barcodeType: productVariants.barcodeType,
            discountType: productVariants.discountType,
            discountPercentage: productVariants.discountPercentage,
            discountAmount: productVariants.discountAmount,
            colorSortOrder: productVariants.colorSortOrder,
            sizeSortOrder: productVariants.sizeSortOrder,
            createdAt: sql<number>`CAST(${productVariants.createdAt} AS INTEGER)`,
            updatedAt: sql<number>`CAST(${productVariants.updatedAt} AS INTEGER)`,
            deletedAt: sql<number | null>`CAST(${productVariants.deletedAt} AS INTEGER)`,
        }).from(productVariants)
            .where(and(eq(productVariants.productId, product.id), isNull(productVariants.deletedAt)))
            .orderBy(productVariants.colorSortOrder, productVariants.sizeSortOrder, productVariants.createdAt)
            .all().then((res: Array<{ id: string; productId: string; size: string | null; color: string | null; weight: number | null; sku: string; price: number; stock: number; reservedStock: number; barcode: string | null; barcodeType: string | null; discountType: string | null; discountPercentage: number | null; discountAmount: number | null; colorSortOrder: number | null; sizeSortOrder: number | null; createdAt: number; updatedAt: number; deletedAt: number | null }>) => ({ type: "variants", data: res })),

        db.select({
            id: productRichContent.id,
            title: productRichContent.title,
            content: productRichContent.content,
        }).from(productRichContent).where(eq(productRichContent.productId, product.id))
            .orderBy(productRichContent.sortOrder).then((res: Array<{ id: string; title: string; content: string }>) => ({ type: "additionalInfo", data: res })),

        db.select({
            name: productAttributes.name,
            value: productAttributeValues.value,
            slug: productAttributes.slug,
        }).from(productAttributeValues)
            .innerJoin(productAttributes, and(
                eq(productAttributeValues.attributeId, productAttributes.id),
                isNull(productAttributes.deletedAt),
                eq(productAttributes.filterable, true),
            ))
            .where(eq(productAttributeValues.productId, product.id))
            .then((res: Array<{ name: string; value: string; slug: string }>) => ({ type: "attributes", data: res })),
    ];

    if (product.categoryId) {
        promises.push(
            db.select({
                id: categories.id, name: categories.name, slug: categories.slug,
                description: categories.description, imageUrl: categories.imageUrl,
                metaTitle: categories.metaTitle, metaDescription: categories.metaDescription,
            }).from(categories).where(eq(categories.id, product.categoryId!)).get()
                .then((res: { id: string; name: string; slug: string; description: string | null; imageUrl: string | null; metaTitle: string | null; metaDescription: string | null } | undefined) => ({ type: "category", data: res })),
        );

        promises.push(
            (async () => {
                const relatedProds: Array<{ id: string; name: string; price: number; slug: string; discountType: string | null; discountPercentage: number | null; discountAmount: number | null; freeDelivery: boolean }> = await db.select({
                    id: products.id, name: products.name, price: products.price,
                    slug: products.slug, discountType: products.discountType,
                    discountPercentage: products.discountPercentage, discountAmount: products.discountAmount,
                    freeDelivery: products.freeDelivery,
                }).from(products)
                    .where(and(
                        eq(products.categoryId, product.categoryId!),
                        eq(products.isActive, true),
                        isNull(products.deletedAt),
                        sql`${products.id} != ${product.id}`,
                    )).limit(6).all();

                if (relatedProds.length === 0) return { type: "relatedProducts", data: [] };

                const relatedIds = relatedProds.map((p) => p.id);
                const relatedImages: Array<{ productId: string; url: string }> = await db
                    .select({ productId: productImages.productId, url: productImages.url })
                    .from(productImages)
                    .where(and(inArray(productImages.productId, relatedIds), eq(productImages.isPrimary, true)))
                    .all();

                const relatedImageMap = new Map(relatedImages.map((img: { productId: string; url: string }) => [img.productId, img.url]));

                return {
                    type: "relatedProducts",
                    data: relatedProds.map((rp) => ({
                        ...rp,
                        imageUrl: relatedImageMap.get(rp.id) || null,
                        discountedPrice: calculateDiscountedPrice(rp.price, rp.discountType, rp.discountPercentage, rp.discountAmount),
                    })),
                };
            })(),
        );
    }

    const results = await Promise.all(promises);

    const images = (results.find((r) => r.type === "images")?.data as unknown[]) || [];
    const variants = (results.find((r) => r.type === "variants")?.data as unknown[]) || [];
    const category = (results.find((r) => r.type === "category")?.data as unknown) || null;
    const additionalInfo = (results.find((r) => r.type === "additionalInfo")?.data as unknown[]) || [];
    const relatedProducts = (results.find((r) => r.type === "relatedProducts")?.data as unknown[]) || [];
    const attributes = (results.find((r) => r.type === "attributes")?.data as unknown[]) || [];

    const hasVariants = variants.length > 0;

    interface VariantResult { id: string; productId: string; size: string | null; color: string | null; weight: number | null; sku: string; price: number; stock: number; reservedStock: number; barcode: string | null; barcodeType: string | null; discountType: string | null; discountPercentage: number | null; discountAmount: number | null; colorSortOrder: number | null; sizeSortOrder: number | null; createdAt: number; updatedAt: number; deletedAt: number | null; }
    interface ImageResult { id: string; productId: string; url: string; alt: string | null; isPrimary: boolean; sortOrder: number; createdAt: number; }
    const typedVariants = variants as VariantResult[];
    const typedImages = images as ImageResult[];

    const formattedVariants = hasVariants
        ? typedVariants.map((v) => ({
            ...v,
            createdAt: unixToDate(v.createdAt)?.toISOString() || null,
            updatedAt: unixToDate(v.updatedAt)?.toISOString() || null,
            deletedAt: v.deletedAt ? unixToDate(v.deletedAt)?.toISOString() : null,
        }))
        : [{
            id: "default",
            productId: product.id,
            size: null, color: null, weight: null,
            sku: `SKU-${product.id}`,
            price: product.price,
            stock: 999999, // Not inventory-managed — always available for purchase
            discountType: "percentage",
            discountPercentage: 0,
            discountAmount: 0,
            createdAt: unixToDate(product.createdAt)?.toISOString() || null,
            updatedAt: unixToDate(product.updatedAt)?.toISOString() || null,
            deletedAt: null,
        }];

    return {
        product: {
            ...product,
            hasVariants,
            createdAt: unixToDate(product.createdAt)?.toISOString() || null,
            updatedAt: unixToDate(product.updatedAt)?.toISOString() || null,
            deletedAt: product.deletedAt ? unixToDate(product.deletedAt)?.toISOString() : null,
            discountType: product.discountType || "percentage",
            discountPercentage: product.discountPercentage || 0,
            discountAmount: product.discountAmount || 0,
            freeDelivery: product.freeDelivery || false,
            features: extractFeatures(product.description),
            discountedPrice: calculateDiscountedPrice(
                product.price, product.discountType,
                product.discountPercentage, product.discountAmount,
            ),
            attributes,
            additionalInfo,
        },
        category,
        images: typedImages.map((img) => ({
            ...img,
            createdAt: unixToDate(img.createdAt)?.toISOString() || null,
            alt: img.alt || product.name,
        })),
        variants: formattedVariants,
        relatedProducts,
    };
}

// ─────────────────────────────────────────
// Storefront search (variant-aware)
// ─────────────────────────────────────────

/**
 * Lightweight variant-aware product search for cart/checkout use.
 * Returns products with their variants and primary image URL.
 */
export async function searchStorefrontProducts(
    db: DrizzleD1Database<typeof schema>,
    params: { search: string; page: number; limit: number },
) {
    const { search, page, limit } = params;
    const offset = (page - 1) * limit;
    const { ftsMatch } = await import("../../search/fts5");
    const { eq, and, isNull, desc, inArray, sql } = await import("drizzle-orm");

    const conditions: Array<ReturnType<typeof eq>> = [
        eq(products.isActive, true),
        isNull(products.deletedAt) as ReturnType<typeof eq>,
    ];
    const searchCondition = search ? ftsMatch("products_fts", "products", search) : null;
    if (searchCondition) conditions.push(searchCondition as ReturnType<typeof eq>);

    const [results, countResults] = await Promise.all([
        db
            .select({
                id: products.id,
                name: products.name,
                price: products.price,
                slug: products.slug,
                discountType: products.discountType,
                discountPercentage: products.discountPercentage,
                discountAmount: products.discountAmount,
                freeDelivery: products.freeDelivery,
            })
            .from(products)
            .where(and(...conditions))
            .orderBy(desc(products.updatedAt))
            .limit(limit)
            .offset(offset)
            .all() as Promise<Array<{ id: string; name: string; price: number; slug: string; discountType: string | null; discountPercentage: number | null; discountAmount: number | null; freeDelivery: boolean }>>,
        db
            .select({ count: sql<number>`count(*)` })
            .from(products)
            .where(and(...conditions)),
    ]);

    const productIds = results.map((p) => p.id);
    const count = Number((countResults[0] as { count: number } | undefined)?.count ?? 0);
    const totalPages = Math.ceil(count / limit);

    const [images, variants] =
        productIds.length > 0
            ? await Promise.all([
                db
                    .select({ productId: productImages.productId, url: productImages.url })
                    .from(productImages)
                    .where(and(eq(productImages.isPrimary, true), inArray(productImages.productId, productIds)))
                    .all() as Promise<Array<{ productId: string; url: string }>>,
                db
                    .select({
                        id: productVariants.id,
                        productId: productVariants.productId,
                        size: productVariants.size,
                        color: productVariants.color,
                        weight: productVariants.weight,
                        sku: productVariants.sku,
                        price: productVariants.price,
                        stock: productVariants.stock,
                        discountType: productVariants.discountType,
                        discountPercentage: productVariants.discountPercentage,
                        discountAmount: productVariants.discountAmount,
                        colorSortOrder: productVariants.colorSortOrder,
                        sizeSortOrder: productVariants.sizeSortOrder,
                    })
                    .from(productVariants)
                    .where(and(inArray(productVariants.productId, productIds), isNull(productVariants.deletedAt)))
                    .orderBy(productVariants.colorSortOrder, productVariants.sizeSortOrder)
                    .all() as Promise<Array<{ id: string; productId: string; size: string | null; color: string | null; weight: number | null; sku: string; price: number; stock: number; discountType: string | null; discountPercentage: number | null; discountAmount: number | null; colorSortOrder: number | null; sizeSortOrder: number | null }>>,
            ])
            : [[], []];

    const imageMap = new Map(
        (images as Array<{ productId: string; url: string }>).map((img) => [img.productId, img.url]),
    );

    return {
        data: results.map((product) => ({
            ...product,
            imageUrl: imageMap.get(product.id) || null,
            variants: (variants as Array<{ productId: string } & Record<string, unknown>>).filter(
                (v) => v.productId === product.id,
            ),
        })),
        pagination: {
            page,
            limit,
            total: count,
            totalPages,
            hasNextPage: page < totalPages,
            hasPrevPage: page > 1,
        },
    };
}
