// The buyer product page read.
import { effectiveLowStockThresholdSql } from "../inventory/low-stock-policy";
import {
    products,
    categories,
    productVariants,
    productRichContent,
    productAttributeValues,
    productAttributes,
} from "@scalius/database/schema";
import { and, sql, eq, isNull } from "drizzle-orm";
import { unixToDate } from "@scalius/shared/utils";
import { fromMinor } from "@scalius/shared/money";
import { listProductBuyGetOffers } from "../promotions/promotions.checkout";
import { maskPublicBuyerAvailability } from "@scalius/shared/buyer-availability";
import type { Database } from "@scalius/database/client";
import {
    publicProductHasBuyerResolvableSku,
    normalizeDefaultSkuOptions,
} from "../products/public-eligibility";
import {
    catalogDiscountedPrice,
    presentCatalogPrice,
    storeCurrencyCodeSql,
    storeCurrencyFromCode,
    storeDecimalPlacesFromCode,
} from "../products/money";
import { loadProductOptions, loadVariantSelectedOptions } from "../products/option-model";
import { publicCategoryConditions } from "../categories/categories.publication";
import {
    loadProductMediaProjections,
    resolveProductImageRepresentation,
    resolveSkuImageRepresentation,
    type ProductMediaProjection,
} from "../products/media";
import {
    DEFAULT_RECOMMENDATION_LIMIT,
    getStorefrontProductRecommendations,
    type ProductRecommendations,
} from "./recommendations";

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

/**
 * Returns full storefront product details (variants, images, attributes, related products)
 * for a single product identified by slug.
 */
export async function getStorefrontProductBySlug(db: Database, slug: string) {
    const productRow = await db
        .select({
            id: products.id,
            name: products.name,
            description: products.description,
            priceMinor: products.priceMinor,
            categoryId: products.categoryId,
            slug: products.slug,
            metaTitle: products.metaTitle,
            metaDescription: products.metaDescription,
            canonicalPath: products.canonicalPath,
            productCondition: products.productCondition,
            noIndex: products.noIndex,
            discountType: products.discountType,
            discountBps: products.discountBps,
            discountAmountMinor: products.discountAmountMinor,
            freeDelivery: products.freeDelivery,
            isActive: products.isActive,
            storeCurrencyCode: storeCurrencyCodeSql(),
            deletedAt: sql<number | null>`CAST(${products.deletedAt} AS INTEGER)`,
            createdAt: sql<number>`CAST(${products.createdAt} AS INTEGER)`,
            updatedAt: sql<number>`CAST(${products.updatedAt} AS INTEGER)`,
            category: {
                id: categories.id,
                name: categories.name,
                slug: categories.slug,
                description: categories.description,
                imageUrl: categories.imageUrl,
                metaTitle: categories.metaTitle,
                metaDescription: categories.metaDescription,
                canonicalPath: categories.canonicalPath,
                noIndex: categories.noIndex,
                excludeFromSitemap: categories.excludeFromSitemap,
            },
        })
        .from(products)
        .leftJoin(categories, and(
            eq(products.categoryId, categories.id),
            ...publicCategoryConditions(),
        ))
        .where(and(
            eq(products.slug, slug),
            eq(products.isActive, true),
            isNull(products.deletedAt),
            publicProductHasBuyerResolvableSku(),
        ))
        .get();

    if (!productRow) return null;
    const { category, storeCurrencyCode, ...product } = productRow;
    const decimalPlaces = storeDecimalPlacesFromCode(storeCurrencyCode);
    const mediaMapPromise = loadProductMediaProjections(db, [product.id]);

    const variantRowsPromise = db.select({
        id: productVariants.id,
        productId: productVariants.productId,
        optionCombinationKey: productVariants.optionCombinationKey,
        imageId: productVariants.imageId,
        weight: productVariants.weight,
        sku: productVariants.sku,
        priceMinor: productVariants.priceMinor,
        stock: productVariants.stock,
        reservedStock: productVariants.reservedStock,
        isDefault: productVariants.isDefault,
        trackInventory: productVariants.trackInventory,
        lowStockThreshold: effectiveLowStockThresholdSql(),
        barcode: productVariants.barcode,
        barcodeType: productVariants.barcodeType,
        discountType: productVariants.discountType,
        discountBps: productVariants.discountBps,
        discountAmountMinor: productVariants.discountAmountMinor,
        createdAt: sql<number>`CAST(${productVariants.createdAt} AS INTEGER)`,
        updatedAt: sql<number>`CAST(${productVariants.updatedAt} AS INTEGER)`,
        deletedAt: sql<number | null>`CAST(${productVariants.deletedAt} AS INTEGER)`,
    }).from(productVariants)
        .where(and(eq(productVariants.productId, product.id), isNull(productVariants.deletedAt)))
        .orderBy(productVariants.createdAt, productVariants.id)
        .all();

    const promises: Promise<{ type: string; data: unknown }>[] = [
        mediaMapPromise.then((mediaMap) => ({
            type: "media",
            // Buyers never need the file's name in Files.
            data: (mediaMap.get(product.id) ?? []).map(({ filename: _filename, ...item }) => item),
        })),

        variantRowsPromise.then((res) => ({ type: "variants", data: res })),

        db.select({
            id: productRichContent.id,
            title: productRichContent.title,
            content: productRichContent.content,
        }).from(productRichContent).where(eq(productRichContent.productId, product.id))
            .orderBy(productRichContent.sortOrder).then((res: Array<{ id: string; title: string; content: string }>) => ({ type: "additionalInfo", data: res })),

        listProductBuyGetOffers(db, product.id, storeCurrencyFromCode(storeCurrencyCode))
            .then((offers) => ({
                type: "offers",
                data: offers.map(({ buyAmountMinor, basisPoints, ...offer }) => ({
                    ...offer,
                    buyAmount: buyAmountMinor === null ? null : fromMinor(buyAmountMinor, decimalPlaces),
                    percentOff: basisPoints / 100,
                })),
            })),

        db.select({
            name: productAttributes.name,
            value: productAttributeValues.value,
            slug: productAttributes.slug,
        }).from(productAttributeValues)
            .innerJoin(productAttributes, and(
                eq(productAttributeValues.attributeId, productAttributes.id),
                isNull(productAttributes.deletedAt),
            ))
            .where(eq(productAttributeValues.productId, product.id))
            .then((res: Array<{ name: string; value: string; slug: string }>) => ({ type: "attributes", data: res })),
    ];

    promises.push(
        getStorefrontProductRecommendations(db, {
            productIds: [product.id],
            limit: DEFAULT_RECOMMENDATION_LIMIT,
        }).then((data) => ({ type: "recommendations", data })),
    );

    // Options need only the product id, so they join this wave; selected
    // options follow the SKU read while recommendations are still loading,
    // so neither adds a wave of its own.
    const optionMapPromise = loadProductOptions(db, [product.id]);
    const selectedOptionMapPromise = variantRowsPromise.then((rows) =>
        loadVariantSelectedOptions(db, rows.map((variant) => variant.id)));
    const [results, optionMap, selectedOptionMap] = await Promise.all([
        Promise.all(promises),
        optionMapPromise,
        selectedOptionMapPromise,
    ]);

    const mediaItems = (results.find((r) => r.type === "media")?.data as ProductMediaProjection[]) || [];
    const variants = (results.find((r) => r.type === "variants")?.data as unknown[]) || [];
    const additionalInfo = (results.find((r) => r.type === "additionalInfo")?.data as unknown[]) || [];
    const recommendations = results.find((r) => r.type === "recommendations")!.data as ProductRecommendations;
    const attributes = (results.find((r) => r.type === "attributes")?.data as unknown[]) || [];
    const offers = (results.find((r) => r.type === "offers")?.data as unknown[]) || [];

    interface VariantResult { id: string; productId: string; optionCombinationKey: string | null; imageId: string | null; weight: number | null; sku: string; priceMinor: number; stock: number; reservedStock: number; isDefault: boolean; trackInventory: boolean; lowStockThreshold: number | null; barcode: string | null; barcodeType: string | null; discountType: string | null; discountBps: number; discountAmountMinor: number; createdAt: number; updatedAt: number; deletedAt: number | null; }
    const typedVariants = variants as VariantResult[];
    const productImage = resolveProductImageRepresentation(mediaItems);
    const publicMedia = mediaItems.map((item) => ({
        id: item.id,
        mediaId: item.mediaId,
        kind: item.kind,
        url: item.url,
        posterMediaId: item.posterMediaId,
        posterUrl: item.posterUrl,
        altText: item.altText,
        caption: item.caption,
        width: item.width,
        height: item.height,
        durationMs: item.durationMs,
        isPrimary: item.isPrimary,
        sortOrder: item.sortOrder,
        status: item.status,
    }));
    const hasVariants = typedVariants.some((variant) =>
        variant.isDefault !== true && Boolean(variant.optionCombinationKey?.trim()),
    );

    const formattedVariants = typedVariants.map((variant) => {
        const v = maskPublicBuyerAvailability(normalizeDefaultSkuOptions(
            presentCatalogPrice(variant, decimalPlaces),
        ));
        const variantImage = resolveSkuImageRepresentation(mediaItems, v.imageId);
        return {
            ...v,
            imageUrl: variantImage?.url ?? null,
            imageMediaId: variantImage?.mediaId ?? null,
            selectedOptions: selectedOptionMap.get(variant.id) ?? [],
            createdAt: unixToDate(v.createdAt)?.toISOString() || null,
            updatedAt: unixToDate(v.updatedAt)?.toISOString() || null,
            deletedAt: v.deletedAt ? unixToDate(v.deletedAt)?.toISOString() : null,
        };
    });
    const productPrice = presentCatalogPrice(product, decimalPlaces);
    return {
        product: {
            ...productPrice,
            categoryId: category ? product.categoryId : null,
            hasVariants,
            imageUrl: productImage?.url ?? null,
            imageMediaId: productImage?.mediaId ?? null,
            imageAlt: productImage?.altText ?? null,
            createdAt: unixToDate(product.createdAt)?.toISOString() || null,
            updatedAt: unixToDate(product.updatedAt)?.toISOString() || null,
            deletedAt: product.deletedAt ? unixToDate(product.deletedAt)?.toISOString() : null,
            options: optionMap.get(product.id) ?? [],
            discountType: product.discountType || "percentage",
            freeDelivery: product.freeDelivery || false,
            features: extractFeatures(product.description),
            discountedPrice: catalogDiscountedPrice(product, storeCurrencyFromCode(storeCurrencyCode)),
            attributes,
            additionalInfo,
            offers,
        },
        category,
        media: publicMedia,
        variants: formattedVariants,
        recommendations,
    };
}
