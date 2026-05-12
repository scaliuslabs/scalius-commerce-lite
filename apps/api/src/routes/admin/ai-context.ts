// src/server/routes/admin/ai-context.ts
// Admin OpenAPI routes for AI context (batch product/category details).

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, asc, inArray, eq, isNull } from "drizzle-orm";
import {
    products,
    productImages,
    productVariants,
    categories,
    productAttributes,
    productAttributeValues,
    type Category,
    type Product,
    type ProductImage,
    type ProductVariant,
    type ProductAttribute,
    type ProductAttributeValue
} from "@scalius/database/schema";
import * as SettingsService from "@scalius/core/modules/settings/settings.service";
import { GENERATION_CONFIG } from "@scalius/core/modules/ai";

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

export function isVariantVisibleForAiContext(variant: Pick<ProductVariant, "deletedAt">): boolean {
    return variant.deletedAt == null;
}

export function isAttributeVisibleForAiContext(attribute: Pick<ProductAttribute, "deletedAt">): boolean {
    return attribute.deletedAt == null;
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
            warnings: z.object({
                productsTruncated: z.boolean(),
                categoriesTruncated: z.boolean(),
                productsUnavailable: z.number(),
                categoriesUnavailable: z.number(),
                maxProducts: z.number(),
                maxCategories: z.number(),
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
        const allCategories = payload.allCategories;

        const productsData: ProductContextDetail[] = [];
        let fetchedCategories: Category[] = [];

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

        return ok(c, {
            products: productsData,
            categories: categoriesData,
            warnings: {
                productsTruncated: (payload.productIds?.length ?? 0) > productIds.length,
                categoriesTruncated:
                    allCategories ||
                    (payload.categoryIds?.length ?? 0) > categoryIds.length,
                productsUnavailable: Math.max(0, productIds.length - productsData.length),
                categoriesUnavailable: allCategories
                    ? 0
                    : Math.max(0, categoryIds.length - categoriesData.length),
                maxProducts: GENERATION_CONFIG.context.maxProducts,
                maxCategories: GENERATION_CONFIG.context.maxCategories,
            },
        });
    } catch (error: unknown) {
        console.error("Batch fetch error:", error);
        throw error;
    }
});

export { app as adminAiContextRoutes };
