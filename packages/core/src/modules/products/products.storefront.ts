// src/modules/products/products.storefront.ts
// Storefront product queries — public-facing read-only operations.
import {
    products,
    categories,
    productVariants,
    productImages,
    productRichContent,
    productAttributeValues,
    productAttributes,
} from "@scalius/database/schema";
import { and, sql, desc, eq, isNull, inArray, or, type SQL } from "drizzle-orm";
import { ftsMatch } from "../../search/fts5";
import { unixToDate } from "@scalius/shared/utils";
import { calculateDiscountedPrice } from "@scalius/shared/price-utils";
import type {
    StorefrontFeedProduct,
    StorefrontFeedProductAttribute,
    StorefrontFeedProductFilterInput,
    StorefrontFeedProductVariant,
    StorefrontProductFilterInput,
} from "./products.types";
import type { Database } from "@scalius/database/client";
import {
    publicProductBaseConditions,
    publicProductHasCustomerOptions,
    publicProductHasAvailableBuyerSku,
    publicProductHasBuyerResolvableSku,
    normalizeDefaultSkuOptions,
} from "./products.public-eligibility";

type StorefrontProductSort = NonNullable<StorefrontProductFilterInput["sort"]>;
type AttributeFilter = NonNullable<StorefrontProductFilterInput["attributeFilters"]>[number];

type StorefrontProductListRow = {
    id: string;
    name: string;
    price: number;
    slug: string;
    discountType: string | null;
    discountPercentage: number | null;
    discountAmount: number | null;
    freeDelivery: boolean;
    categoryId: string | null;
    createdAt: number;
    updatedAt: number;
};

type StorefrontProductListRowWithVariants = StorefrontProductListRow & {
    hasCustomerOptions: boolean;
    availableForSale: boolean;
};

type StorefrontFeedProductListRow = {
    id: string;
    name: string;
    description: string | null;
    price: number;
    slug: string;
    discountType: string | null;
    discountPercentage: number | null;
    discountAmount: number | null;
    freeDelivery: boolean;
    categoryId: string | null;
    updatedAt: number;
    hasCustomerOptions: boolean;
    availableForSale: boolean;
};

type StorefrontFeedVariantRow = Omit<StorefrontFeedProductVariant, "deletedAt"> & {
    deletedAt: number | null;
};

export interface StorefrontCategoryProductCategory {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    imageUrl: string | null;
    metaTitle: string | null;
    metaDescription: string | null;
    createdAt: string | null;
    updatedAt: string | null;
}

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

function buildStorefrontProductConditions(params: StorefrontProductFilterInput): SQL[] {
    const {
        category,
        search,
        minPrice,
        maxPrice,
        freeDelivery,
        hasDiscount,
        ids,
    } = params;

    const conditions: (SQL | undefined)[] = publicProductBaseConditions();

    if (category) conditions.push(eq(products.categoryId, category));
    if (search) {
        const cond = ftsMatch("products_fts", "products", search);
        conditions.push(cond ?? sql`0 = 1`);
    }
    if (minPrice !== undefined) conditions.push(sql`${products.price} >= ${minPrice}`);
    if (maxPrice !== undefined) conditions.push(sql`${products.price} <= ${maxPrice}`);
    if (freeDelivery === "true") conditions.push(eq(products.freeDelivery, true));
    else if (freeDelivery === "false") conditions.push(eq(products.freeDelivery, false));
    if (hasDiscount === "true") {
        conditions.push(sql`(${products.discountPercentage} > 0 OR ${products.discountAmount} > 0)`);
    } else if (hasDiscount === "false") {
        conditions.push(sql`(${products.discountPercentage} IS NULL OR ${products.discountPercentage} = 0) AND (${products.discountAmount} IS NULL OR ${products.discountAmount} = 0)`);
    }
    if (ids) {
        const productIds = ids.split(",").filter(Boolean);
        if (productIds.length > 0) conditions.push(inArray(products.id, productIds));
    }

    return conditions.filter((condition): condition is SQL => Boolean(condition));
}

function getStorefrontProductOrderBy(sort: StorefrontProductSort = "newest") {
    const effectivePriceSql = sql`CASE
        WHEN ${products.discountType} = 'flat' AND ${products.discountAmount} > 0 THEN MAX(${products.price} - ${products.discountAmount}, 0)
        WHEN ${products.discountPercentage} > 0 THEN ROUND(${products.price} * (1 - ${products.discountPercentage} / 100.0))
        ELSE ${products.price}
    END`;

    if (sort === "price-asc") {
        return effectivePriceSql;
    }
    if (sort === "price-desc") {
        return desc(effectivePriceSql);
    }
    if (sort === "name-asc") {
        return products.name;
    }
    if (sort === "name-desc") {
        return desc(products.name);
    }
    if (sort === "discount") {
        return desc(sql`CASE
            WHEN ${products.price} > 0 AND ${products.discountType} = 'flat' AND ${products.discountAmount} > 0 THEN ${products.discountAmount} / ${products.price} * 100
            WHEN ${products.discountPercentage} > 0 THEN ${products.discountPercentage}
            ELSE 0
        END`);
    }
    return desc(products.createdAt);
}

function buildAttributeProductSubquery(
    db: Database,
    attributeFilters: AttributeFilter[],
    alias: string,
) {
    if (attributeFilters.length === 0) return null;

    if (attributeFilters.length === 1) {
        const filter = attributeFilters[0]!;
        return db
            .select({ productId: productAttributeValues.productId })
            .from(productAttributeValues)
            .innerJoin(productAttributes, eq(productAttributeValues.attributeId, productAttributes.id))
            .where(
                and(
                    eq(productAttributes.slug, filter.slug),
                    eq(productAttributeValues.value, filter.value),
                ),
            )
            .as(alias);
    }

    return db
        .select({ productId: productAttributeValues.productId })
        .from(productAttributeValues)
        .innerJoin(productAttributes, eq(productAttributeValues.attributeId, productAttributes.id))
        .where(
            or(
                ...attributeFilters.map((filter) =>
                    and(
                        eq(productAttributes.slug, filter.slug),
                        eq(productAttributeValues.value, filter.value),
                    ),
                ),
            ),
        )
        .groupBy(productAttributeValues.productId)
        .having(sql`count(*) = ${attributeFilters.length}`)
        .as(alias);
}

function getPagination(page: number, limit: number, total: number) {
    return {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
    };
}

async function readPrimaryProductImageMap(
    db: Database,
    productIds: string[],
): Promise<Map<string, { url: string; alt: string | null }>> {
    if (productIds.length === 0) {
        return new Map();
    }

    const images = await db
        .select({
            productId: productImages.productId,
            url: productImages.url,
            alt: productImages.alt,
        })
        .from(productImages)
        .where(and(eq(productImages.isPrimary, true), inArray(productImages.productId, productIds)))
        .all();

    return new Map(images.map((img) => [img.productId, { url: img.url, alt: img.alt }]));
}

async function readStorefrontFeedAttributeMap(
    db: Database,
    productIds: string[],
): Promise<Map<string, StorefrontFeedProductAttribute[]>> {
    if (productIds.length === 0) {
        return new Map();
    }

    const rows = await db
        .select({
            productId: productAttributeValues.productId,
            name: productAttributes.name,
            slug: productAttributes.slug,
            value: productAttributeValues.value,
        })
        .from(productAttributeValues)
        .innerJoin(
            productAttributes,
            and(
                eq(productAttributeValues.attributeId, productAttributes.id),
                eq(productAttributes.filterable, true),
                isNull(productAttributes.deletedAt),
            ),
        )
        .where(inArray(productAttributeValues.productId, productIds))
        .all();

    const attributeMap = new Map<string, StorefrontFeedProductAttribute[]>();
    for (const row of rows) {
        const attributes = attributeMap.get(row.productId) ?? [];
        attributes.push({ name: row.name, slug: row.slug, value: row.value });
        attributeMap.set(row.productId, attributes);
    }

    return attributeMap;
}

async function readStorefrontFeedVariantMap(
    db: Database,
    productIds: string[],
): Promise<Map<string, StorefrontFeedProductVariant[]>> {
    if (productIds.length === 0) {
        return new Map();
    }

    const rows = await db
        .select({
            id: productVariants.id,
            productId: productVariants.productId,
            size: productVariants.size,
            color: productVariants.color,
            weight: productVariants.weight,
            sku: productVariants.sku,
            price: productVariants.price,
            stock: productVariants.stock,
            reservedStock: productVariants.reservedStock,
            isDefault: productVariants.isDefault,
            trackInventory: productVariants.trackInventory,
            discountType: productVariants.discountType,
            discountPercentage: productVariants.discountPercentage,
            discountAmount: productVariants.discountAmount,
            colorSortOrder: productVariants.colorSortOrder,
            sizeSortOrder: productVariants.sizeSortOrder,
            deletedAt: sql<number | null>`CAST(${productVariants.deletedAt} AS INTEGER)`,
        })
        .from(productVariants)
        .where(and(inArray(productVariants.productId, productIds), isNull(productVariants.deletedAt)))
        .orderBy(productVariants.productId, productVariants.colorSortOrder, productVariants.sizeSortOrder)
        .all() as StorefrontFeedVariantRow[];

    const variantMap = new Map<string, StorefrontFeedProductVariant[]>();
    for (const row of rows) {
        const variant = normalizeDefaultSkuOptions({
            ...row,
            deletedAt: row.deletedAt ? unixToDate(row.deletedAt)?.toISOString() ?? null : null,
        });
        const variants = variantMap.get(row.productId) ?? [];
        variants.push(variant);
        variantMap.set(row.productId, variants);
    }

    return variantMap;
}

// ─────────────────────────────────────────
// Storefront queries
// ─────────────────────────────────────────

/**
 * Returns a paginated list of active storefront products with images and categories.
 * This is the unified query backing the Hono GET /api/storefront/products route.
 */
export async function getStorefrontProducts(db: Database, params: StorefrontProductFilterInput) {
    const {
        page = 1,
        limit = 20,
        sort = "newest",
        attributeFilters = [],
    } = params;
    const conditions = buildStorefrontProductConditions(params);
    const orderBy = getStorefrontProductOrderBy(sort);
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
            hasCustomerOptions: publicProductHasCustomerOptions(sql`${products.id}`).as("hasCustomerOptions"),
            availableForSale: publicProductHasAvailableBuyerSku(sql`${products.id}`).as("availableForSale"),
        })
        .from(products)
        .where(and(...conditions));

    const attributeSubquery = buildAttributeProductSubquery(db, attributeFilters, "filtered_products");
    if (attributeSubquery) {
        query = query.innerJoin(attributeSubquery, eq(products.id, attributeSubquery.productId));
    }

    // Count is independent from the current page rows, so start both reads together.
    let countQuery = db
        .select({ count: sql<number>`count(*)` })
        .from(products)
        .where(and(...conditions));

    const countSubquery = buildAttributeProductSubquery(db, attributeFilters, "count_filtered_products");
    if (countSubquery) {
        countQuery = countQuery.innerJoin(countSubquery, eq(products.id, countSubquery.productId));
    }

    const [productsList, totalCount] = await Promise.all([
        query.orderBy(orderBy).limit(limit).offset(offset).all(),
        countQuery.get(),
    ]);
    const productIds = productsList.map((p) => p.id);

    let categoryMap = new Map<string, { id: string; name: string; slug: string }>();
    const categoryIds = [...new Set(productsList.map((p) => p.categoryId).filter(Boolean))] as string[];
    const [imageMap, categoriesData] = await Promise.all([
        readPrimaryProductImageMap(db, productIds),
        categoryIds.length > 0
            ? db
            .select({ id: categories.id, name: categories.name, slug: categories.slug })
            .from(categories)
            .where(inArray(categories.id, categoryIds))
            .all() as Promise<Array<{ id: string; name: string; slug: string }>>
            : Promise.resolve([] as Array<{ id: string; name: string; slug: string }>),
    ]);
    categoryMap = new Map(categoriesData.map((cat) => [cat.id, cat]));

    const productsWithImages = productsList.map(({ hasCustomerOptions, availableForSale, ...product }: StorefrontProductListRowWithVariants) => {
        const imgData = imageMap.get(product.id);
        return {
            ...product,
            hasVariants: Boolean(hasCustomerOptions),
            availableForSale: Boolean(availableForSale),
            imageUrl: imgData?.url || null,
            imageAlt: imgData?.alt || null,
            category: product.categoryId ? categoryMap.get(product.categoryId) || null : null,
            createdAt: unixToDate(product.createdAt)?.toISOString() || null,
            updatedAt: unixToDate(product.updatedAt)?.toISOString() || null,
            discountedPrice: calculateDiscountedPrice(
                product.price, product.discountType,
                product.discountPercentage, product.discountAmount,
            ),
        };
    });

    return {
        products: productsWithImages,
        pagination: getPagination(page, limit, totalCount?.count || 0),
    };
}

/**
 * Returns a paginated feed projection for catalog exporters.
 * This keeps normal storefront listings card-light while letting feed callers
 * read attributes and SKU data in page-wide bulk queries.
 */
export async function getStorefrontFeedProducts(
    db: Database,
    params: StorefrontFeedProductFilterInput,
) {
    const {
        page = 1,
        limit = 100,
        sort = "newest",
    } = params;
    const conditions = buildStorefrontProductConditions({});
    const orderBy = getStorefrontProductOrderBy(sort);
    const offset = (page - 1) * limit;

    const query = db
        .select({
            id: products.id,
            name: products.name,
            description: products.description,
            price: products.price,
            slug: products.slug,
            discountType: products.discountType,
            discountPercentage: products.discountPercentage,
            discountAmount: products.discountAmount,
            freeDelivery: products.freeDelivery,
            categoryId: products.categoryId,
            updatedAt: sql<number>`CAST(${products.updatedAt} AS INTEGER)`.as("updatedAt"),
            hasCustomerOptions: publicProductHasCustomerOptions(sql`${products.id}`).as("hasCustomerOptions"),
            availableForSale: publicProductHasAvailableBuyerSku(sql`${products.id}`).as("availableForSale"),
        })
        .from(products)
        .where(and(...conditions));

    const countQuery = db
        .select({ count: sql<number>`count(*)` })
        .from(products)
        .where(and(...conditions));

    const [productsList, totalCount] = await Promise.all([
        query.orderBy(orderBy).limit(limit).offset(offset).all(),
        countQuery.get(),
    ]);
    const productIds = productsList.map((product) => product.id);
    const categoryIds = [...new Set(productsList.map((product) => product.categoryId).filter(Boolean))] as string[];

    const [imageMap, categoriesData, attributeMap, variantMap] = await Promise.all([
        readPrimaryProductImageMap(db, productIds),
        categoryIds.length > 0
            ? db
                .select({ id: categories.id, name: categories.name, slug: categories.slug })
                .from(categories)
                .where(inArray(categories.id, categoryIds))
                .all() as Promise<Array<{ id: string; name: string; slug: string }>>
            : Promise.resolve([] as Array<{ id: string; name: string; slug: string }>),
        readStorefrontFeedAttributeMap(db, productIds),
        readStorefrontFeedVariantMap(db, productIds),
    ]);
    const categoryMap = new Map(categoriesData.map((cat) => [cat.id, cat]));

    const feedProducts: StorefrontFeedProduct[] = productsList.map((product: StorefrontFeedProductListRow) => {
        const imgData = imageMap.get(product.id);
        return {
            id: product.id,
            name: product.name,
            slug: product.slug,
            description: product.description,
            price: product.price,
            discountType: product.discountType,
            discountPercentage: product.discountPercentage,
            discountAmount: product.discountAmount,
            discountedPrice: calculateDiscountedPrice(
                product.price,
                product.discountType,
                product.discountPercentage,
                product.discountAmount,
            ),
            freeDelivery: product.freeDelivery,
            categoryId: product.categoryId,
            hasVariants: Boolean(product.hasCustomerOptions),
            availableForSale: Boolean(product.availableForSale),
            imageUrl: imgData?.url || null,
            imageAlt: imgData?.alt || null,
            category: product.categoryId ? categoryMap.get(product.categoryId) || null : null,
            attributes: attributeMap.get(product.id) ?? [],
            variants: variantMap.get(product.id) ?? [],
            updatedAt: unixToDate(product.updatedAt)?.toISOString() || null,
        };
    });

    return {
        products: feedProducts,
        pagination: getPagination(page, limit, totalCount?.count || 0),
    };
}

/**
 * Returns category-scoped storefront products using the shared public product
 * filtering/sort core, without the extra variant/category enrichment needed by
 * the global product list endpoint.
 */
export async function getStorefrontCategoryProducts(
    db: Database,
    category: StorefrontCategoryProductCategory,
    params: StorefrontProductFilterInput,
) {
    const {
        page = 1,
        limit = 20,
        sort = "newest",
        attributeFilters = [],
    } = params;
    const conditions = buildStorefrontProductConditions({
        ...params,
        category: category.id,
    });
    const orderBy = getStorefrontProductOrderBy(sort);
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
        })
        .from(products)
        .where(and(...conditions));

    const attributeSubquery = buildAttributeProductSubquery(db, attributeFilters, "category_filtered_products");
    if (attributeSubquery) {
        query = query.innerJoin(attributeSubquery, eq(products.id, attributeSubquery.productId));
    }

    let countQuery = db
        .select({ count: sql<number>`count(*)` })
        .from(products)
        .where(and(...conditions));

    const countSubquery = buildAttributeProductSubquery(db, attributeFilters, "category_count_filtered_products");
    if (countSubquery) {
        countQuery = countQuery.innerJoin(countSubquery, eq(products.id, countSubquery.productId));
    }

    const [productsList, totalCount] = await Promise.all([
        query.orderBy(orderBy).limit(limit).offset(offset).all(),
        countQuery.get(),
    ]);

    const imageMap = await readPrimaryProductImageMap(
        db,
        productsList.map((product) => product.id),
    );
    const productsWithImages = productsList.map((product: StorefrontProductListRow) => {
        const imgData = imageMap.get(product.id);
        return {
            ...product,
            imageUrl: imgData?.url || null,
            discountedPrice: calculateDiscountedPrice(
                product.price,
                product.discountType,
                product.discountPercentage,
                product.discountAmount,
            ),
            createdAt: unixToDate(product.createdAt)?.toISOString() || null,
            updatedAt: unixToDate(product.updatedAt)?.toISOString() || null,
            category,
        };
    });

    return {
        products: productsWithImages,
        pagination: getPagination(page, limit, totalCount?.count || 0),
    };
}

/**
 * Returns full storefront product details (variants, images, attributes, related products)
 * for a single product identified by slug.
 */
export async function getStorefrontProductBySlug(db: Database, slug: string) {
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
        .where(and(
            eq(products.slug, slug),
            eq(products.isActive, true),
            isNull(products.deletedAt),
            publicProductHasBuyerResolvableSku(),
        ))
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
            isDefault: productVariants.isDefault,
            trackInventory: productVariants.trackInventory,
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
            .all().then((res: Array<{ id: string; productId: string; size: string | null; color: string | null; weight: number | null; sku: string; price: number; stock: number; reservedStock: number; isDefault: boolean; trackInventory: boolean; barcode: string | null; barcodeType: string | null; discountType: string | null; discountPercentage: number | null; discountAmount: number | null; colorSortOrder: number | null; sizeSortOrder: number | null; createdAt: number; updatedAt: number; deletedAt: number | null }>) => ({ type: "variants", data: res })),

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
                        publicProductHasBuyerResolvableSku(),
                        sql`${products.id} != ${product.id}`,
                    )).limit(6).all();

                if (relatedProds.length === 0) return { type: "relatedProducts", data: [] };

                const relatedIds = relatedProds.map((p) => p.id);
                const relatedImages: Array<{ productId: string; url: string; alt: string | null }> = await db
                    .select({ productId: productImages.productId, url: productImages.url, alt: productImages.alt })
                    .from(productImages)
                    .where(and(inArray(productImages.productId, relatedIds), eq(productImages.isPrimary, true)))
                    .all();

                const relatedImageMap = new Map(relatedImages.map((img: { productId: string; url: string; alt: string | null }) => [img.productId, { url: img.url, alt: img.alt }]));

                return {
                    type: "relatedProducts",
                    data: relatedProds.map((rp) => {
                        const imgData = relatedImageMap.get(rp.id);
                        return {
                            ...rp,
                            imageUrl: imgData?.url || null,
                            imageAlt: imgData?.alt || null,
                            discountedPrice: calculateDiscountedPrice(rp.price, rp.discountType, rp.discountPercentage, rp.discountAmount),
                        };
                    }),
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

    interface VariantResult { id: string; productId: string; size: string | null; color: string | null; weight: number | null; sku: string; price: number; stock: number; reservedStock: number; isDefault: boolean; trackInventory: boolean; barcode: string | null; barcodeType: string | null; discountType: string | null; discountPercentage: number | null; discountAmount: number | null; colorSortOrder: number | null; sizeSortOrder: number | null; createdAt: number; updatedAt: number; deletedAt: number | null; }
    interface ImageResult { id: string; productId: string; url: string; alt: string | null; isPrimary: boolean; sortOrder: number; createdAt: number; }
    const typedVariants = variants as VariantResult[];
    const typedImages = images as ImageResult[];
    const hasVariants = typedVariants.some((variant) =>
        variant.isDefault !== true && Boolean(variant.size?.trim() || variant.color?.trim()),
    );

    const formattedVariants = typedVariants.map((variant) => {
        const v = normalizeDefaultSkuOptions(variant);
        return {
            ...v,
            createdAt: unixToDate(v.createdAt)?.toISOString() || null,
            updatedAt: unixToDate(v.updatedAt)?.toISOString() || null,
            deletedAt: v.deletedAt ? unixToDate(v.deletedAt)?.toISOString() : null,
        };
    });

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
    db: Database,
    params: { search: string; page: number; limit: number },
) {
    const { search, page, limit } = params;
    const offset = (page - 1) * limit;

    const conditions: SQL[] = publicProductBaseConditions();
    const searchCondition = search ? ftsMatch("products_fts", "products", search) : null;
    if (search) {
        conditions.push(searchCondition ?? sql`0 = 1`);
    }

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
                    .select({ productId: productImages.productId, url: productImages.url, alt: productImages.alt })
                    .from(productImages)
                    .where(and(eq(productImages.isPrimary, true), inArray(productImages.productId, productIds)))
                    .all() as Promise<Array<{ productId: string; url: string; alt: string | null }>>,
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
                        reservedStock: productVariants.reservedStock,
                        isDefault: productVariants.isDefault,
                        trackInventory: productVariants.trackInventory,
                        discountType: productVariants.discountType,
                        discountPercentage: productVariants.discountPercentage,
                        discountAmount: productVariants.discountAmount,
                        colorSortOrder: productVariants.colorSortOrder,
                        sizeSortOrder: productVariants.sizeSortOrder,
                    })
                    .from(productVariants)
                    .where(and(inArray(productVariants.productId, productIds), isNull(productVariants.deletedAt)))
                    .orderBy(productVariants.colorSortOrder, productVariants.sizeSortOrder)
                    .all() as Promise<Array<{ id: string; productId: string; size: string | null; color: string | null; weight: number | null; sku: string; price: number; stock: number; reservedStock: number; isDefault: boolean; trackInventory: boolean; discountType: string | null; discountPercentage: number | null; discountAmount: number | null; colorSortOrder: number | null; sizeSortOrder: number | null }>>,
            ])
            : [[], []];

    const imageMap = new Map(
        (images as Array<{ productId: string; url: string; alt: string | null }>).map((img) => [img.productId, { url: img.url, alt: img.alt }]),
    );

    return {
        data: results.map((product) => {
            const imgData = imageMap.get(product.id);
            return {
                ...product,
                imageUrl: imgData?.url || null,
                imageAlt: imgData?.alt || null,
                variants: (variants as Array<{
                    productId: string;
                    isDefault: boolean;
                    size: string | null;
                    color: string | null;
                } & Record<string, unknown>>)
                    .filter((v) => v.productId === product.id)
                    .map((v) => normalizeDefaultSkuOptions(v)),
            };
        }),
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
