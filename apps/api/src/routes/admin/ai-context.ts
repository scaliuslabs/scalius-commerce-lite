// src/server/routes/admin/ai-context.ts
// Admin OpenAPI routes for AI context (batch product/category details).

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { inArray, eq, isNull } from "drizzle-orm";
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
    type ProductAttributeValue
} from "@scalius/database/schema";
import * as SettingsService from "@scalius/core/modules/settings/settings.service";

const app = new OpenAPIHono();

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
    productIds: z.array(z.string()).optional(),
    categoryIds: z.array(z.string()).optional(),
    allCategories: z.boolean().optional()
});

const batchDetailsRoute = createRoute({
    method: "post",
    path: "/batch-details",
    tags: ["Admin - AI Context"],
    summary: "Fetch batch product and category details for AI context",
    request: {
        body: { content: { "application/json": { schema: batchDetailsSchema } } }
    },
    responses: {
        200: { description: "Batch details"  }
    }
});

app.openapi(batchDetailsRoute, async (c) => {
    try {
        const db = c.get("db");
        const kv = c.get("env")?.CACHE;
        const { productIds, categoryIds, allCategories } = c.req.valid("json");

        let productsData: ProductContextDetail[] = [];
        let fetchedCategories: Category[] = [];

        if (productIds && productIds.length > 0) {
            const productResults = await db
                .select()
                .from(products)
                .where(inArray(products.id, productIds));

            if (productResults.length > 0) {
                const allProductIds = productResults.map((p: any) => p.id);
                const allCategoryIds = productResults
                    .map((p: any) => p.categoryId)
                    .filter(Boolean) as string[];

                const [images, variants, attributesResult, categoryResults] =
                    await Promise.all([
                        db
                            .select()
                            .from(productImages)
                            .where(inArray(productImages.productId, allProductIds)),
                        db
                            .select()
                            .from(productVariants)
                            .where(inArray(productVariants.productId, allProductIds)),
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
                            .where(inArray(productAttributeValues.productId, allProductIds)),
                        allCategoryIds.length > 0
                            ? db
                                .select()
                                .from(categories)
                                .where(inArray(categories.id, allCategoryIds))
                            : Promise.resolve([]),
                    ]);

                const categoriesWithUrls = await Promise.all(
                    categoryResults.map(async (cat: any) => ({
                        ...cat,
                        url: await SettingsService.getStorefrontPath(db, `/categories/${cat.slug}`, kv)
                    })),
                );
                const categoryMap = new Map(categoriesWithUrls.map((c: any) => [c.id, c]));

                for (const product of productResults) {
                    const productUrl = await SettingsService.getStorefrontPath(db, `/products/${product.slug}`, kv);
                    const buyNowUrl = await SettingsService.getStorefrontPath(db, `/buy/${product.slug}`, kv);
                    const productCategory = product.categoryId
                        ? categoryMap.get(product.categoryId)
                        : null;

                    const productVariantsList = variants.filter((v: any) => v.productId === product.id);
                    const variantsWithBuyNowUrls: VariantWithBuyNowUrl[] = await Promise.all(
                        productVariantsList.map(async (variant: any) => {
                            const finalPrice = calculateFinalPrice(
                                variant.price,
                                variant.discountType,
                                variant.discountAmount,
                                variant.discountPercentage
                            );

                            return {
                                ...variant,
                                buyNowUrl: await SettingsService.getStorefrontPath(db, `/buy/${product.slug}?variant=${variant.id}`, kv),
                                finalPrice
                            };
                        })
                    );

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
                        images: images.filter((img: any) => img.productId === product.id),
                        variants: variantsWithBuyNowUrls,
                        attributes: attributesResult
                            .filter((attr: any) => attr.value.productId === product.id)
                            .map((res: any) => ({
                                ...res.value,
                                name: res.attribute.name,
                                slug: res.attribute.slug
                            }))
                    } as any);
                }
            }
        }

        if (allCategories) {
            fetchedCategories = await db
                .select()
                .from(categories)
                .where(isNull(categories.deletedAt));
        } else if (categoryIds && categoryIds.length > 0) {
            fetchedCategories = await db
                .select()
                .from(categories)
                .where(inArray(categories.id, categoryIds));
        }

        const categoriesData: CategoryContextDetail[] = await Promise.all(
            fetchedCategories.map(async (cat) => {
                const url = await SettingsService.getStorefrontPath(db, `/categories/${cat.slug}`, kv);
                return { ...cat, url };
            }),
        );

        return c.json({
            products: productsData,
            categories: categoriesData
        }, 200);
    } catch (error: any) {
        console.error("Batch fetch error:", error);
        return c.json(
            { error: "Failed to fetch details", message: error.message },
            500,
        );
    }
});

export { app as adminAiContextRoutes };
