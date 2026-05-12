// src/server/routes/admin/ai-context.ts
// Admin OpenAPI routes for AI context (batch product/category/collection details).

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, asc, inArray, eq, isNull } from "drizzle-orm";
import {
    products,
    productImages,
    productVariants,
    categories,
    collections,
    productAttributes,
    productAttributeValues,
    type Category,
    type Collection,
    type Product,
    type ProductImage,
    type ProductVariant,
    type ProductAttribute,
    type ProductAttributeValue
} from "@scalius/database/schema";
import * as SettingsService from "@scalius/core/modules/settings/settings.service";
import { GENERATION_CONFIG } from "@scalius/core/modules/ai";
import { resolveCollectionProductsBatch } from "@scalius/core/modules/collections/collections.service";
import type { ResolvedProduct } from "@scalius/core/modules/collections/collections.service";

import { ok } from "../../utils/api-response";
import { successEnvelope, errorResponses } from "../../schemas/responses";
const app = new OpenAPIHono<{ Bindings: Env }>();

interface VariantWithBuyNowUrl extends ProductVariant {
    buyNowUrl: string;
    finalPrice: number;
}

interface ProductContextDetail extends Product {
    url: string;
    buyNowUrl: string;
    finalPrice: number;
    category: (Pick<Category, "id" | "name" | "slug"> & { url: string }) | null;
    images: ProductImage[];
    variants: VariantWithBuyNowUrl[];
    attributes: (ProductAttributeValue & { name: string; slug: string })[];
}

interface CategoryContextDetail extends Category {
    url: string;
}

type CollectionPlacementRole = "target" | "anchor";

interface CollectionContextConfig {
    title?: string;
    subtitle?: string;
    productIds?: string[];
    categoryIds?: string[];
    featuredProductId?: string;
    maxProducts?: number;
}

interface CollectionProductContextDetail {
    id: string;
    name: string;
    slug: string;
    url: string;
    price: number;
    discountedPrice: number;
    imageUrl: string | null;
    imageAlt: string | null;
}

interface CollectionCategoryContextDetail {
    id: string;
    name: string;
    slug: string;
    url: string;
}

interface CollectionContextDetail {
    id: string;
    name: string;
    type: Collection["type"];
    url: string;
    title: string | null;
    subtitle: string | null;
    placementRoles: CollectionPlacementRole[];
    products: CollectionProductContextDetail[];
    categories: CollectionCategoryContextDetail[];
    featuredProduct: CollectionProductContextDetail | null;
}

function calculateFinalPrice(
    basePrice: number,
    discountType: "percentage" | "flat" | null,
    discountAmount: number | null,
    discountPercentage: number | null
): number {
    if (!discountType) return basePrice;

    if (discountType === "percentage" && discountPercentage) {
        return basePrice - (basePrice * discountPercentage) / 100;
    } else if (discountType === "flat" && discountAmount) {
        return Math.max(0, basePrice - discountAmount);
    }

    return basePrice;
}

const batchDetailsSchema = z.object({
    productIds: z.array(z.string()).max(GENERATION_CONFIG.context.maxProducts).optional(),
    categoryIds: z.array(z.string()).max(GENERATION_CONFIG.context.maxCategories).optional(),
    collectionIds: z.array(z.string()).max(GENERATION_CONFIG.context.maxCollections).optional(),
    anchorCollectionIds: z.array(z.string()).max(GENERATION_CONFIG.context.maxCollections).optional(),
    allCategories: z.boolean().optional()
});

function uniqueLimited(values: string[] | undefined, limit: number): string[] {
    return Array.from(new Set(values ?? [])).slice(0, limit);
}

export function isProductVisibleForAiContext(product: Pick<Product, "isActive" | "deletedAt">): boolean {
    return product.isActive && product.deletedAt == null;
}

export function isCategoryVisibleForAiContext(category: Pick<Category, "deletedAt">): boolean {
    return category.deletedAt == null;
}

export function isCollectionVisibleForAiContext(collection: Pick<Collection, "isActive" | "deletedAt">): boolean {
    return collection.isActive && collection.deletedAt == null;
}

export function isVariantVisibleForAiContext(variant: Pick<ProductVariant, "deletedAt">): boolean {
    return variant.deletedAt == null;
}

export function isAttributeVisibleForAiContext(attribute: Pick<ProductAttribute, "deletedAt">): boolean {
    return attribute.deletedAt == null;
}

function parseCollectionConfig(value: string): CollectionContextConfig {
    try {
        const parsed = JSON.parse(value) as unknown;
        return parsed && typeof parsed === "object"
            ? parsed as CollectionContextConfig
            : {};
    } catch {
        return {};
    }
}

function toCollectionProductContext(
    product: ResolvedProduct,
    url: string,
): CollectionProductContextDetail {
    return {
        id: product.id,
        name: product.name,
        slug: product.slug,
        url,
        price: product.price,
        discountedPrice: product.discountedPrice,
        imageUrl: product.imageUrl,
        imageAlt: product.imageAlt,
    };
}

const batchDetailsRoute = createRoute({
    method: "post",
    path: "/batch-details",
    tags: ["Admin - AI Context"],
    summary: "Fetch batch product and category details for AI context",
    request: {
        body: { content: { "application/json": { schema: batchDetailsSchema } } }
    },
    responses: {
        200: { description: "Batch details", content: { "application/json": { schema: successEnvelope(z.object({
            products: z.array(z.object({ id: z.string(), name: z.string(), slug: z.string(), price: z.number(), url: z.string(), buyNowUrl: z.string(), finalPrice: z.number() }).passthrough()),
            categories: z.array(z.object({ id: z.string(), name: z.string(), slug: z.string(), url: z.string() }).passthrough()),
            collections: z.array(z.object({
                id: z.string(),
                name: z.string(),
                type: z.enum(["manual", "dynamic"]),
                url: z.string(),
                products: z.array(z.object({ id: z.string(), name: z.string(), slug: z.string(), url: z.string() }).passthrough()),
                categories: z.array(z.object({ id: z.string(), name: z.string(), slug: z.string(), url: z.string() }).passthrough()),
            }).passthrough()),
            warnings: z.object({
                productsTruncated: z.boolean(),
                categoriesTruncated: z.boolean(),
                collectionsTruncated: z.boolean(),
                productsUnavailable: z.number(),
                categoriesUnavailable: z.number(),
                collectionsUnavailable: z.number(),
                maxProducts: z.number(),
                maxCategories: z.number(),
                maxCollections: z.number(),
            }),
        })) } } },
        ...errorResponses,
    }
});

app.openapi(batchDetailsRoute, async (c) => {
    try {
        const db = c.get("db");
        const kv = (c.env as Record<string, unknown>)?.CACHE as KVNamespace | undefined;
        const payload = c.req.valid("json");
        const productIds = uniqueLimited(payload.productIds, GENERATION_CONFIG.context.maxProducts);
        const categoryIds = uniqueLimited(payload.categoryIds, GENERATION_CONFIG.context.maxCategories);
        const requestedCollectionIds = uniqueLimited(payload.collectionIds, GENERATION_CONFIG.context.maxCollections);
        const requestedAnchorCollectionIds = uniqueLimited(
            payload.anchorCollectionIds,
            GENERATION_CONFIG.context.maxCollections,
        );
        const collectionRolesById = new Map<string, Set<CollectionPlacementRole>>();
        for (const id of requestedCollectionIds) {
            collectionRolesById.set(id, new Set(["target"]));
        }
        for (const id of requestedAnchorCollectionIds) {
            const roles = collectionRolesById.get(id) ?? new Set<CollectionPlacementRole>();
            roles.add("anchor");
            collectionRolesById.set(id, roles);
        }
        const collectionIds = Array.from(collectionRolesById.keys())
            .slice(0, GENERATION_CONFIG.context.maxCollections);
        const allCategories = payload.allCategories;

        const productsData: ProductContextDetail[] = [];
        let fetchedCategories: Category[] = [];
        let collectionsData: CollectionContextDetail[] = [];

        if (productIds.length > 0) {
            const productResults = await db
                .select()
                .from(products)
                .where(and(
                    inArray(products.id, productIds),
                    eq(products.isActive, true),
                    isNull(products.deletedAt),
                ));
            const productOrder = new Map(productIds.map((id, index) => [id, index]));
            productResults.sort((a, b) => (productOrder.get(a.id) ?? 0) - (productOrder.get(b.id) ?? 0));

            if (productResults.length > 0) {
                const allProductIds = productResults.map((p) => p.id);
                const allCategoryIds = Array.from(new Set(
                    productResults
                        .map((p) => p.categoryId)
                        .filter(Boolean) as string[],
                ));

                const [images, variants, attributesResult, categoryResults] =
                    await Promise.all([
                        db
                            .select()
                            .from(productImages)
                            .where(inArray(productImages.productId, allProductIds)),
                        db
                            .select()
                            .from(productVariants)
                            .where(and(
                                inArray(productVariants.productId, allProductIds),
                                isNull(productVariants.deletedAt),
                            )),
                        db
                            .select({
                                value: productAttributeValues,
                                attribute: productAttributes
                            })
                            .from(productAttributeValues)
                            .innerJoin(
                                productAttributes,
                                eq(productAttributeValues.attributeId, productAttributes.id),
                            )
                            .where(and(
                                inArray(productAttributeValues.productId, allProductIds),
                                isNull(productAttributes.deletedAt),
                            )),
                        allCategoryIds.length > 0
                            ? db
                                .select()
                                .from(categories)
                                .where(and(
                                    inArray(categories.id, allCategoryIds),
                                    isNull(categories.deletedAt),
                                ))
                            : Promise.resolve([]),
                    ]);

                // Batch all storefront path lookups in a single Promise.all
                const allPaths: string[] = [];
                // Category paths
                for (const cat of categoryResults) allPaths.push(`/categories/${cat.slug}`);
                // Product paths (url + buyNow per product)
                for (const product of productResults) {
                    allPaths.push(`/products/${product.slug}`);
                    allPaths.push(`/buy/${product.slug}`);
                }
                // Variant paths
                for (const variant of variants) {
                    const product = productResults.find((p) => p.id === variant.productId);
                    if (product) allPaths.push(`/buy/${product.slug}?variant=${variant.id}`);
                }

                const resolvedUrls = await Promise.all(
                    allPaths.map((path) => SettingsService.getStorefrontPath(db, path, kv))
                );
                const urlMap = new Map(allPaths.map((path, i) => [path, resolvedUrls[i]!]));

                const categoriesWithUrls = categoryResults.map((cat) => ({
                    ...cat,
                    url: urlMap.get(`/categories/${cat.slug}`)!
                }));
                const categoryMap = new Map(categoriesWithUrls.map((c) => [c.id, c]));

                for (const product of productResults) {
                    const productUrl = urlMap.get(`/products/${product.slug}`)!;
                    const buyNowUrl = urlMap.get(`/buy/${product.slug}`)!;
                    const productCategory = product.categoryId
                        ? categoryMap.get(product.categoryId)
                        : null;

                    const productVariantsList = variants.filter((v) => v.productId === product.id);
                    const variantsWithBuyNowUrls: VariantWithBuyNowUrl[] = productVariantsList.map((variant) => {
                        const finalPrice = calculateFinalPrice(
                            variant.price,
                            variant.discountType,
                            variant.discountAmount,
                            variant.discountPercentage
                        );
                        return {
                            ...variant,
                            buyNowUrl: urlMap.get(`/buy/${product.slug}?variant=${variant.id}`)!,
                            finalPrice
                        };
                    });

                    const productFinalPrice = calculateFinalPrice(
                        product.price,
                        product.discountType,
                        product.discountAmount,
                        product.discountPercentage
                    );

                    productsData.push({
                        ...product,
                        url: productUrl,
                        buyNowUrl: buyNowUrl,
                        finalPrice: productFinalPrice,
                        category: productCategory
                            ? {
                                id: productCategory.id,
                                name: productCategory.name,
                                slug: productCategory.slug,
                                url: productCategory.url
                            }
                            : null,
                        images: images.filter((img) => img.productId === product.id),
                        variants: variantsWithBuyNowUrls,
                        attributes: attributesResult
                            .filter((attr) => attr.value.productId === product.id)
                            .map((res) => ({
                                ...res.value,
                                name: res.attribute.name,
                                slug: res.attribute.slug
                            }))
                    } as ProductContextDetail);
                }
            }
        }

        if (allCategories) {
            fetchedCategories = await db
                .select()
                .from(categories)
                .where(isNull(categories.deletedAt))
                .orderBy(asc(categories.name), asc(categories.id))
                .limit(GENERATION_CONFIG.context.maxCategories);
        } else if (categoryIds.length > 0) {
            fetchedCategories = await db
                .select()
                .from(categories)
                .where(and(
                    inArray(categories.id, categoryIds),
                    isNull(categories.deletedAt),
                ));
            const categoryOrder = new Map(categoryIds.map((id, index) => [id, index]));
            fetchedCategories.sort((a, b) => (categoryOrder.get(a.id) ?? 0) - (categoryOrder.get(b.id) ?? 0));
        }

        const categoriesData: CategoryContextDetail[] = await Promise.all(
            fetchedCategories.map(async (cat) => {
                const url = await SettingsService.getStorefrontPath(db, `/categories/${cat.slug}`, kv);
                return { ...cat, url };
            }),
        );

        if (collectionIds.length > 0) {
            const collectionRows = await db
                .select()
                .from(collections)
                .where(and(
                    inArray(collections.id, collectionIds),
                    eq(collections.isActive, true),
                    isNull(collections.deletedAt),
                ));
            const collectionOrder = new Map(collectionIds.map((id, index) => [id, index]));
            collectionRows.sort((a, b) => (collectionOrder.get(a.id) ?? 0) - (collectionOrder.get(b.id) ?? 0));

            const parsedCollections = collectionRows.map((collection) => ({
                id: collection.id,
                config: parseCollectionConfig(collection.config),
            }));
            const resolvedByCollection = await resolveCollectionProductsBatch(db, parsedCollections);
            const collectionPaths = new Set<string>();

            for (const collection of collectionRows) {
                collectionPaths.add(`/collections/${collection.id}`);
            }
            for (const resolved of resolvedByCollection.values()) {
                for (const product of resolved.products) {
                    collectionPaths.add(`/products/${product.slug}`);
                }
                if (resolved.featuredProduct) {
                    collectionPaths.add(`/products/${resolved.featuredProduct.slug}`);
                }
                for (const category of resolved.categories) {
                    collectionPaths.add(`/categories/${category.slug}`);
                }
            }

            const collectionPathList = Array.from(collectionPaths);
            const resolvedPaths = await Promise.all(
                collectionPathList.map((path) => SettingsService.getStorefrontPath(db, path, kv)),
            );
            const collectionUrlMap = new Map(collectionPathList.map((path, index) => [path, resolvedPaths[index]!]));

            collectionsData = collectionRows.map((collection) => {
                const config = parseCollectionConfig(collection.config);
                const resolved = resolvedByCollection.get(collection.id) ?? {
                    products: [],
                    categories: [],
                    featuredProduct: null,
                };
                const toProduct = (product: ResolvedProduct) => toCollectionProductContext(
                    product,
                    collectionUrlMap.get(`/products/${product.slug}`)!,
                );

                return {
                    id: collection.id,
                    name: collection.name,
                    type: collection.type,
                    url: collectionUrlMap.get(`/collections/${collection.id}`)!,
                    title: typeof config.title === "string" && config.title.trim()
                        ? config.title.trim()
                        : null,
                    subtitle: typeof config.subtitle === "string" && config.subtitle.trim()
                        ? config.subtitle.trim()
                        : null,
                    placementRoles: Array.from(collectionRolesById.get(collection.id) ?? []),
                    products: resolved.products.map(toProduct),
                    categories: resolved.categories.map((category) => ({
                        ...category,
                        url: collectionUrlMap.get(`/categories/${category.slug}`)!,
                    })),
                    featuredProduct: resolved.featuredProduct
                        ? toProduct(resolved.featuredProduct)
                        : null,
                };
            });
        }

        return ok(c, {
            products: productsData,
            categories: categoriesData,
            collections: collectionsData,
            warnings: {
                productsTruncated: (payload.productIds?.length ?? 0) > productIds.length,
                categoriesTruncated:
                    allCategories ||
                    (payload.categoryIds?.length ?? 0) > categoryIds.length,
                collectionsTruncated:
                    ((payload.collectionIds?.length ?? 0) + (payload.anchorCollectionIds?.length ?? 0)) >
                    collectionIds.length,
                productsUnavailable: Math.max(0, productIds.length - productsData.length),
                categoriesUnavailable: allCategories
                    ? 0
                    : Math.max(0, categoryIds.length - categoriesData.length),
                collectionsUnavailable: Math.max(0, collectionIds.length - collectionsData.length),
                maxProducts: GENERATION_CONFIG.context.maxProducts,
                maxCategories: GENERATION_CONFIG.context.maxCategories,
                maxCollections: GENERATION_CONFIG.context.maxCollections,
            },
        });
    } catch (error: unknown) {
        console.error("Batch fetch error:", error);
        throw error;
    }
});

export { app as adminAiContextRoutes };
