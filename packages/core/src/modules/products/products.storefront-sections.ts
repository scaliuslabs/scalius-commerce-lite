import type { Database } from "@scalius/database/client";
import { ValidationError } from "@scalius/core/errors";
import {
    categories,
    media,
    productAttributes,
    productAttributeValues,
    productMedia,
    productOptionDefinitions,
    productOptionValues,
    productRichContent,
    productVariants,
    products,
} from "@scalius/database/schema";
import { effectiveRegularReservedStockSql } from "@scalius/database/inventory-authority";
import { calculateDiscountedPrice } from "@scalius/shared/price-utils";
import { maskPublicBuyerAvailability } from "@scalius/shared/buyer-availability";
import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import {
    getCurrentPublicMediaUrl,
} from "../../integrations/storage";
import {
    publicProductHasBuyerResolvableSku,
    normalizeDefaultSkuOptions,
} from "./products.public-eligibility";
import { publicCategoryConditions } from "../categories/categories.publication";
import { loadVariantSelectedOptions } from "./products.option-model";
import { buildBuyerCatalogPricingProjection } from "./products.buyer-projection";
import {
    resolveProductImageRepresentation,
    resolveProductMediaProjectionRows,
    resolveSkuImageRepresentation,
    selectCheckoutProductMediaProjectionRows,
} from "./products.media";
import type { ProductMediaProjection } from "./products.media";
import type { ProductMediaProjectionRow } from "./products.media";
import { unixToDate } from "@scalius/shared/utils";

export const STOREFRONT_PRODUCT_TEXT_CHUNK_MAX = 12_000;
export const STOREFRONT_PRODUCT_SECTION_RESULT_MAX_BYTES = 60 * 1024;

export const storefrontProductSectionSchema = z.enum([
    "summary",
    "text",
    "media",
    "attributes",
    "additional_info",
    "additional_info_text",
    "options",
    "option_values",
    "variants",
    "related_products",
]);

export const storefrontProductSectionQuerySchema = z.object({
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    field: z.enum(["description", "metaTitle", "metaDescription", "title", "content"]).optional(),
    itemId: z.string().trim().min(1).max(180).optional(),
});

export type StorefrontProductSection = z.infer<typeof storefrontProductSectionSchema>;
export type StorefrontProductSectionQuery = z.infer<typeof storefrontProductSectionQuerySchema>;
type StorefrontProductSectionSource = {
    product: Record<string, any>;
    category: Record<string, any> | null;
    media: ProductMediaProjection[];
    variants: Array<Record<string, any>>;
    relatedProducts: PublicRelatedProduct[];
};
export type StorefrontProductDetail = StorefrontProductSectionSource;
type PublicProductAttribute = { name: string; slug: string; value: string };
type PublicProductAdditionalInfo = { id: string; title: string; content: string };
type PublicProductCategoryIdentity = { id: string; name: string; slug: string };
type PublicRelatedProduct = {
    id: string;
    name: string;
    price: number;
    slug: string;
    discountType: string | null;
    discountPercentage: number | null;
    discountAmount: number | null;
    discountedPrice: number;
    hasVariants: boolean;
    availableForSale: boolean;
    priceVaries: boolean;
    freeDelivery: boolean;
    imageUrl: string | null;
    imageMediaId: string | null;
    imageAlt: string | null;
};

function chunkText(value: string | null, offset: number) {
    const text = value ?? "";
    const chunk = text.slice(offset, offset + STOREFRONT_PRODUCT_TEXT_CHUNK_MAX);
    const nextOffset = offset + chunk.length < text.length ? offset + chunk.length : null;
    return {
        value: chunk,
        totalCharacters: text.length,
        offset,
        nextOffset,
        isNull: value === null,
    };
}

function page<T>(items: readonly T[], offset: number, requestedLimit: number, maximumLimit: number) {
    const limit = Math.min(requestedLimit, maximumLimit);
    const values = items.slice(offset, offset + limit);
    const nextOffset = offset + values.length < items.length ? offset + values.length : null;
    return { items: values, total: items.length, offset, limit, nextOffset };
}

function assertBoundedResult<T>(result: T): T {
    const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
    if (bytes > STOREFRONT_PRODUCT_SECTION_RESULT_MAX_BYTES) {
        throw new ValidationError(
            "The requested storefront product section exceeds its bounded response. Use a smaller limit.",
        );
    }
    return result;
}

/**
 * Projects the existing buyer-authoritative product detail into reconstructable,
 * response-bounded sections. Inventory remains band-only: exact stock and
 * reservation counters are deliberately absent from the public projection.
 */
export function projectStorefrontProductSection(
    detail: StorefrontProductSectionSource,
    section: StorefrontProductSection,
    query: StorefrontProductSectionQuery,
) {
    const product = detail.product;
    const attributes = product.attributes as PublicProductAttribute[];
    const additionalInfo = product.additionalInfo as PublicProductAdditionalInfo[];
    const relatedProducts = detail.relatedProducts as PublicRelatedProduct[];

    if (section === "summary") {
        return assertBoundedResult({
            section,
            product: {
                id: product.id,
                name: product.name,
                price: product.price,
                categoryId: product.categoryId,
                slug: product.slug,
                canonicalPath: product.canonicalPath,
                productCondition: product.productCondition,
                noIndex: product.noIndex,
                discountType: product.discountType,
                discountPercentage: product.discountPercentage,
                discountAmount: product.discountAmount,
                discountedPrice: product.discountedPrice,
                freeDelivery: product.freeDelivery,
                hasVariants: product.hasVariants,
                imageUrl: product.imageUrl,
                imageMediaId: product.imageMediaId,
                imageAlt: product.imageAlt,
                createdAt: product.createdAt,
                updatedAt: product.updatedAt,
                category: detail.category ? {
                    id: detail.category.id,
                    name: detail.category.name,
                    slug: detail.category.slug,
                } satisfies PublicProductCategoryIdentity : null,
                textLengths: {
                    description: product.description?.length ?? 0,
                    metaTitle: product.metaTitle?.length ?? 0,
                    metaDescription: product.metaDescription?.length ?? 0,
                },
                counts: {
                    media: detail.media.length,
                    attributes: attributes.length,
                    additionalInfo: additionalInfo.length,
                    options: product.options.length,
                    variants: detail.variants.length,
                    relatedProducts: relatedProducts.length,
                },
            },
        });
    }

    if (section === "text") {
        if (!query.field || !["description", "metaTitle", "metaDescription"].includes(query.field)) {
            throw new ValidationError(
                "field must be description, metaTitle, or metaDescription for the text section.",
            );
        }
        const field = query.field as "description" | "metaTitle" | "metaDescription";
        return assertBoundedResult({ section, field, ...chunkText(product[field], query.offset) });
    }

    if (section === "media") {
        return assertBoundedResult({ section, ...page(detail.media, query.offset, query.limit, 20) });
    }

    if (section === "attributes") {
        return assertBoundedResult({
            section,
            ...page(attributes, query.offset, query.limit, 50),
        });
    }

    if (section === "additional_info") {
        return assertBoundedResult({
            section,
            ...page(additionalInfo.map((item) => ({
                id: item.id,
                titleCharacters: item.title.length,
                contentCharacters: item.content.length,
            })), query.offset, query.limit, 50),
        });
    }

    if (section === "additional_info_text") {
        if (!query.itemId || (query.field !== "title" && query.field !== "content")) {
            throw new ValidationError(
                "itemId and field=title|content are required for additional_info_text.",
            );
        }
        const item = additionalInfo.find((candidate) => candidate.id === query.itemId);
        if (!item) throw new ValidationError("Additional information item not found.");
        return assertBoundedResult({
            section,
            itemId: item.id,
            field: query.field,
            ...chunkText(item[query.field], query.offset),
        });
    }

    if (section === "options") {
        return assertBoundedResult({
            section,
            ...page(product.options.map((option: Record<string, any>) => ({
                id: option.id,
                name: option.name,
                position: option.position,
                standardMapping: option.standardMapping,
                valueCount: Array.isArray(option.values) ? option.values.length : 0,
            })), query.offset, query.limit, 5),
        });
    }

    if (section === "option_values") {
        if (!query.itemId) throw new ValidationError("itemId is required for option_values.");
        const option = product.options.find((candidate: Record<string, any>) => candidate.id === query.itemId);
        if (!option) throw new ValidationError("Product option not found.");
        return assertBoundedResult({
            section,
            itemId: option.id,
            ...page(option.values, query.offset, query.limit, 50),
        });
    }

    if (section === "variants") {
        return assertBoundedResult({
            section,
            ...page(detail.variants.map((variant) => ({
                id: variant.id,
                productId: variant.productId,
                optionCombinationKey: variant.optionCombinationKey,
                imageId: variant.imageId,
                imageMediaId: variant.imageMediaId,
                imageUrl: variant.imageUrl,
                selectedOptions: variant.selectedOptions,
                weight: variant.weight,
                sku: variant.sku,
                price: variant.price,
                availabilityBand: variant.availabilityBand,
                isDefault: variant.isDefault,
                discountType: variant.discountType,
                discountPercentage: variant.discountPercentage,
                discountAmount: variant.discountAmount,
                barcode: variant.barcode,
                barcodeType: variant.barcodeType,
                createdAt: variant.createdAt,
                updatedAt: variant.updatedAt,
            })), query.offset, query.limit, 10),
        });
    }

    return assertBoundedResult({
        section: "related_products" as const,
        ...page(relatedProducts, query.offset, query.limit, 10),
    });
}

async function readPublicProductIdentity(db: Database, slug: string) {
    return db.select({
        id: products.id,
        name: products.name,
        price: products.price,
        categoryId: products.categoryId,
        slug: products.slug,
        descriptionCharacters: sql<number>`length(coalesce(${products.description}, ''))`,
        metaTitleCharacters: sql<number>`length(coalesce(${products.metaTitle}, ''))`,
        metaDescriptionCharacters: sql<number>`length(coalesce(${products.metaDescription}, ''))`,
        canonicalPath: products.canonicalPath,
        productCondition: products.productCondition,
        noIndex: products.noIndex,
        discountType: products.discountType,
        discountPercentage: products.discountPercentage,
        discountAmount: products.discountAmount,
        freeDelivery: products.freeDelivery,
        createdAt: sql<number>`CAST(${products.createdAt} AS INTEGER)`,
        updatedAt: sql<number>`CAST(${products.updatedAt} AS INTEGER)`,
        category: {
            id: categories.id,
            name: categories.name,
            slug: categories.slug,
        },
    }).from(products)
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
}

function pagination(total: number, offset: number, requestedLimit: number, maximumLimit: number) {
    const limit = Math.min(requestedLimit, maximumLimit);
    return { total, offset, limit, nextOffset: offset + limit < total ? offset + limit : null };
}

async function readMediaPage(
    db: Database,
    productId: string,
    productName: string,
    offset: number,
    requestedLimit: number,
) {
    const limit = Math.min(requestedLimit, 20);
    const poster = alias(media, "product_section_poster");
    const [rows, totalRows] = await Promise.all([
        db.select({
            id: productMedia.id,
            mediaId: productMedia.mediaId,
            kind: media.kind,
            objectKey: media.objectKey,
            mediaAltText: media.altText,
            contextualAltText: productMedia.altText,
            caption: media.caption,
            width: media.width,
            height: media.height,
            durationMs: media.durationMs,
            posterMediaId: poster.id,
            posterObjectKey: poster.objectKey,
            posterKind: poster.kind,
            posterStatus: poster.status,
            isPrimary: productMedia.isPrimary,
            sortOrder: productMedia.sortOrder,
            status: media.status,
        }).from(productMedia)
            .innerJoin(media, eq(media.id, productMedia.mediaId))
            .leftJoin(poster, eq(poster.id, media.posterMediaId))
            .where(and(
                eq(productMedia.productId, productId),
                sql`${media.status} IN ('ready', 'trashed')`,
            ))
            .orderBy(asc(productMedia.sortOrder), asc(productMedia.id))
            .limit(limit)
            .offset(offset),
        db.select({ total: count() }).from(productMedia)
            .innerJoin(media, eq(media.id, productMedia.mediaId))
            .where(and(
                eq(productMedia.productId, productId),
                sql`${media.status} IN ('ready', 'trashed')`,
            )).get(),
    ]);
    return {
        items: rows.map((row) => ({
            id: row.id,
            mediaId: row.mediaId,
            kind: row.kind,
            url: getCurrentPublicMediaUrl(row.objectKey),
            posterMediaId: row.posterObjectKey && row.posterKind === "image" && (row.posterStatus === "ready" || row.posterStatus === "trashed")
                ? row.posterMediaId
                : null,
            posterUrl: row.posterObjectKey && row.posterKind === "image" && (row.posterStatus === "ready" || row.posterStatus === "trashed")
                ? getCurrentPublicMediaUrl(row.posterObjectKey)
                : null,
            altText: row.contextualAltText ?? row.mediaAltText ?? productName,
            caption: row.caption,
            width: row.width,
            height: row.height,
            durationMs: row.durationMs,
            isPrimary: row.isPrimary,
            sortOrder: row.sortOrder,
            status: row.status as "ready" | "trashed",
        })),
        ...pagination(Number(totalRows?.total ?? 0), offset, requestedLimit, 20),
    };
}

async function readSummary(db: Database, identity: NonNullable<Awaited<ReturnType<typeof readPublicProductIdentity>>>) {
    const [counts, primaryProjectionRows, relatedRows] = await Promise.all([
        db.select({
            media: sql<number>`(SELECT count(*) FROM product_media WHERE product_id = ${identity.id})`,
            attributes: sql<number>`(SELECT count(*) FROM product_attribute_values WHERE product_id = ${identity.id})`,
            additionalInfo: sql<number>`(SELECT count(*) FROM product_rich_content WHERE product_id = ${identity.id})`,
            options: sql<number>`(SELECT count(*) FROM product_option_definitions WHERE product_id = ${identity.id} AND deleted_at IS NULL)`,
            variants: sql<number>`(SELECT count(*) FROM product_variants WHERE product_id = ${identity.id} AND deleted_at IS NULL)`,
        }).from(products).where(eq(products.id, identity.id)).get(),
        selectCheckoutProductMediaProjectionRows(db, [identity.id], []),
        identity.categoryId
            ? db.select({ id: products.id }).from(products).where(and(
                eq(products.categoryId, identity.categoryId),
                sql`${products.id} != ${identity.id}`,
                eq(products.isActive, true),
                isNull(products.deletedAt),
                publicProductHasBuyerResolvableSku(),
            )).limit(6)
            : Promise.resolve([]),
    ]);
    const mediaProjection = resolveProductMediaProjectionRows(
        primaryProjectionRows as unknown as ProductMediaProjectionRow[],
    ).get(identity.id) ?? [];
    const primaryImage = resolveProductImageRepresentation(mediaProjection);
    const discountType = identity.discountType || "percentage";
    const discountPercentage = identity.discountPercentage || 0;
    const discountAmount = identity.discountAmount || 0;
    return {
        section: "summary" as const,
        product: {
            id: identity.id,
            name: identity.name,
            price: identity.price,
            categoryId: identity.category ? identity.categoryId : null,
            slug: identity.slug,
            canonicalPath: identity.canonicalPath,
            productCondition: identity.productCondition,
            noIndex: identity.noIndex,
            discountType,
            discountPercentage,
            discountAmount,
            discountedPrice: calculateDiscountedPrice(identity.price, discountType, discountPercentage, discountAmount),
            freeDelivery: identity.freeDelivery || false,
            hasVariants: Number(counts?.variants ?? 0) > 1,
            imageUrl: primaryImage?.url ?? null,
            imageMediaId: primaryImage?.mediaId ?? null,
            imageAlt: primaryImage?.altText ?? null,
            createdAt: unixToDate(identity.createdAt)?.toISOString() ?? null,
            updatedAt: unixToDate(identity.updatedAt)?.toISOString() ?? null,
            category: identity.category,
            textLengths: {
                description: identity.descriptionCharacters,
                metaTitle: identity.metaTitleCharacters,
                metaDescription: identity.metaDescriptionCharacters,
            },
            counts: {
                media: Number(counts?.media ?? 0),
                attributes: Number(counts?.attributes ?? 0),
                additionalInfo: Number(counts?.additionalInfo ?? 0),
                options: Number(counts?.options ?? 0),
                variants: Number(counts?.variants ?? 0),
                relatedProducts: relatedRows.length,
            },
        },
    };
}

export async function getStorefrontProductSection(
    db: Database,
    slug: string,
    section: StorefrontProductSection,
    query: StorefrontProductSectionQuery,
) {
    const identity = await readPublicProductIdentity(db, slug);
    if (!identity) return null;

    if (section === "summary") {
        return assertBoundedResult(await readSummary(db, identity));
    }

    if (section === "text") {
        if (!query.field || !["description", "metaTitle", "metaDescription"].includes(query.field)) {
            throw new ValidationError(
                "field must be description, metaTitle, or metaDescription for the text section.",
            );
        }
        const field = query.field as "description" | "metaTitle" | "metaDescription";
        const column = field === "description"
            ? products.description
            : field === "metaTitle"
                ? products.metaTitle
                : products.metaDescription;
        const row = await db.select({
            value: sql<string>`substr(coalesce(${column}, ''), ${query.offset + 1}, ${STOREFRONT_PRODUCT_TEXT_CHUNK_MAX})`,
            totalCharacters: sql<number>`length(coalesce(${column}, ''))`,
            isNull: sql<number>`CASE WHEN ${column} IS NULL THEN 1 ELSE 0 END`,
        }).from(products).where(eq(products.id, identity.id)).get();
        const value = row?.value ?? "";
        const totalCharacters = Number(row?.totalCharacters ?? 0);
        return assertBoundedResult({
            section,
            field,
            value,
            totalCharacters,
            offset: query.offset,
            nextOffset: query.offset + value.length < totalCharacters ? query.offset + value.length : null,
            isNull: Boolean(row?.isNull),
        });
    }

    if (section === "media") {
        return assertBoundedResult({
            section,
            ...await readMediaPage(db, identity.id, identity.name, query.offset, query.limit),
        });
    }

    if (section === "attributes") {
        const limit = Math.min(query.limit, 50);
        const [items, totalRow] = await Promise.all([
            db.select({
                name: productAttributes.name,
                slug: productAttributes.slug,
                value: productAttributeValues.value,
            }).from(productAttributeValues)
                .innerJoin(productAttributes, and(
                    eq(productAttributeValues.attributeId, productAttributes.id),
                    isNull(productAttributes.deletedAt),
                ))
                .where(eq(productAttributeValues.productId, identity.id))
                .orderBy(asc(productAttributes.slug), asc(productAttributeValues.id))
                .limit(limit)
                .offset(query.offset),
            db.select({ total: count() }).from(productAttributeValues)
                .innerJoin(productAttributes, and(
                    eq(productAttributeValues.attributeId, productAttributes.id),
                    isNull(productAttributes.deletedAt),
                ))
                .where(eq(productAttributeValues.productId, identity.id)).get(),
        ]);
        return assertBoundedResult({
            section,
            items,
            ...pagination(Number(totalRow?.total ?? 0), query.offset, query.limit, 50),
        });
    }

    if (section === "additional_info") {
        const limit = Math.min(query.limit, 50);
        const [items, totalRow] = await Promise.all([
            db.select({
                id: productRichContent.id,
                titleCharacters: sql<number>`length(${productRichContent.title})`,
                contentCharacters: sql<number>`length(${productRichContent.content})`,
            }).from(productRichContent)
                .where(eq(productRichContent.productId, identity.id))
                .orderBy(asc(productRichContent.sortOrder), asc(productRichContent.id))
                .limit(limit)
                .offset(query.offset),
            db.select({ total: count() }).from(productRichContent)
                .where(eq(productRichContent.productId, identity.id)).get(),
        ]);
        return assertBoundedResult({
            section,
            items,
            ...pagination(Number(totalRow?.total ?? 0), query.offset, query.limit, 50),
        });
    }

    if (section === "additional_info_text") {
        if (!query.itemId || (query.field !== "title" && query.field !== "content")) {
            throw new ValidationError(
                "itemId and field=title|content are required for additional_info_text.",
            );
        }
        const field = query.field;
        const column = field === "title" ? productRichContent.title : productRichContent.content;
        const item = await db.select({
            id: productRichContent.id,
            value: sql<string>`substr(${column}, ${query.offset + 1}, ${STOREFRONT_PRODUCT_TEXT_CHUNK_MAX})`,
            totalCharacters: sql<number>`length(${column})`,
        }).from(productRichContent).where(and(
            eq(productRichContent.id, query.itemId),
            eq(productRichContent.productId, identity.id),
        )).get();
        if (!item) throw new ValidationError("Additional information item not found.");
        return assertBoundedResult({
            section,
            itemId: item.id,
            field,
            value: item.value,
            totalCharacters: item.totalCharacters,
            offset: query.offset,
            nextOffset: query.offset + item.value.length < item.totalCharacters
                ? query.offset + item.value.length
                : null,
            isNull: false,
        });
    }

    if (section === "options") {
        const limit = Math.min(query.limit, 5);
        const [definitions, totalRow] = await Promise.all([
            db.select({
                id: productOptionDefinitions.id,
                name: productOptionDefinitions.name,
                position: productOptionDefinitions.position,
                standardMapping: productOptionDefinitions.standardMapping,
                valueCount: sql<number>`(
                    SELECT count(*) FROM product_option_values AS public_option_value
                    WHERE public_option_value.option_definition_id = ${productOptionDefinitions.id}
                      AND public_option_value.deleted_at IS NULL
                )`,
            }).from(productOptionDefinitions).where(and(
                eq(productOptionDefinitions.productId, identity.id),
                isNull(productOptionDefinitions.deletedAt),
            )).orderBy(asc(productOptionDefinitions.position), asc(productOptionDefinitions.id))
                .limit(limit).offset(query.offset),
            db.select({ total: count() }).from(productOptionDefinitions).where(and(
                eq(productOptionDefinitions.productId, identity.id),
                isNull(productOptionDefinitions.deletedAt),
            )).get(),
        ]);
        return assertBoundedResult({
            section,
            items: definitions,
            ...pagination(Number(totalRow?.total ?? 0), query.offset, query.limit, 5),
        });
    }

    if (section === "option_values") {
        if (!query.itemId) throw new ValidationError("itemId is required for option_values.");
        const definition = await db.select({ id: productOptionDefinitions.id })
            .from(productOptionDefinitions).where(and(
                eq(productOptionDefinitions.id, query.itemId),
                eq(productOptionDefinitions.productId, identity.id),
                isNull(productOptionDefinitions.deletedAt),
            )).get();
        if (!definition) throw new ValidationError("Product option not found.");
        const limit = Math.min(query.limit, 50);
        const [items, totalRow] = await Promise.all([
            db.select({
                id: productOptionValues.id,
                value: productOptionValues.value,
                position: productOptionValues.position,
            }).from(productOptionValues).where(and(
                eq(productOptionValues.optionDefinitionId, definition.id),
                isNull(productOptionValues.deletedAt),
            )).orderBy(asc(productOptionValues.position), asc(productOptionValues.id))
                .limit(limit).offset(query.offset),
            db.select({ total: count() }).from(productOptionValues).where(and(
                eq(productOptionValues.optionDefinitionId, definition.id),
                isNull(productOptionValues.deletedAt),
            )).get(),
        ]);
        return assertBoundedResult({
            section,
            itemId: definition.id,
            items,
            ...pagination(Number(totalRow?.total ?? 0), query.offset, query.limit, 50),
        });
    }

    if (section === "variants") {
        const limit = Math.min(query.limit, 10);
        const [rows, totalRow] = await Promise.all([
            db.select({
                id: productVariants.id,
                productId: productVariants.productId,
                optionCombinationKey: productVariants.optionCombinationKey,
                imageId: productVariants.imageId,
                weight: productVariants.weight,
                sku: productVariants.sku,
                price: productVariants.price,
                stock: productVariants.stock,
                reservedStock: effectiveRegularReservedStockSql(),
                isDefault: productVariants.isDefault,
                trackInventory: productVariants.trackInventory,
                lowStockThreshold: productVariants.lowStockThreshold,
                barcode: productVariants.barcode,
                barcodeType: productVariants.barcodeType,
                discountType: productVariants.discountType,
                discountPercentage: productVariants.discountPercentage,
                discountAmount: productVariants.discountAmount,
                createdAt: sql<number>`CAST(${productVariants.createdAt} AS INTEGER)`,
                updatedAt: sql<number>`CAST(${productVariants.updatedAt} AS INTEGER)`,
            }).from(productVariants).where(and(
                eq(productVariants.productId, identity.id),
                isNull(productVariants.deletedAt),
            )).orderBy(asc(productVariants.createdAt), asc(productVariants.id))
                .limit(limit).offset(query.offset),
            db.select({ total: count() }).from(productVariants).where(and(
                eq(productVariants.productId, identity.id),
                isNull(productVariants.deletedAt),
            )).get(),
        ]);
        const [selectedOptionMap, mediaRows] = await Promise.all([
            loadVariantSelectedOptions(db, rows.map((row) => row.id)),
            selectCheckoutProductMediaProjectionRows(db, [identity.id], rows.map((row) => row.id)),
        ]);
        const mediaProjection = resolveProductMediaProjectionRows(
            mediaRows as unknown as ProductMediaProjectionRow[],
        ).get(identity.id) ?? [];
        const items = rows.map((row) => {
            const masked = maskPublicBuyerAvailability(normalizeDefaultSkuOptions({
                ...row,
                selectedOptions: selectedOptionMap.get(row.id) ?? [],
            }));
            const variantImage = resolveSkuImageRepresentation(mediaProjection, row.imageId);
            return {
                id: row.id,
                productId: row.productId,
                optionCombinationKey: masked.optionCombinationKey,
                imageId: row.imageId,
                imageMediaId: variantImage?.mediaId ?? null,
                imageUrl: variantImage?.url ?? null,
                selectedOptions: selectedOptionMap.get(row.id) ?? [],
                weight: row.weight,
                sku: row.sku,
                price: row.price,
                availabilityBand: masked.availabilityBand,
                isDefault: row.isDefault,
                discountType: row.discountType,
                discountPercentage: row.discountPercentage,
                discountAmount: row.discountAmount,
                barcode: row.barcode,
                barcodeType: row.barcodeType,
                createdAt: unixToDate(row.createdAt)?.toISOString() ?? null,
                updatedAt: unixToDate(row.updatedAt)?.toISOString() ?? null,
            };
        });
        return assertBoundedResult({
            section,
            items,
            ...pagination(Number(totalRow?.total ?? 0), query.offset, query.limit, 10),
        });
    }

    const pricing = buildBuyerCatalogPricingProjection(db);
    const limit = Math.min(query.limit, 10);
    const relatedConditions = identity.categoryId ? and(
        eq(products.categoryId, identity.categoryId),
        sql`${products.id} != ${identity.id}`,
        eq(products.isActive, true),
        isNull(products.deletedAt),
        publicProductHasBuyerResolvableSku(),
    ) : undefined;
    const [rows, relatedCountRow] = relatedConditions && query.offset < 6
        ? await Promise.all([db.select({
            id: products.id,
            name: products.name,
            price: pricing.basePrice,
            slug: products.slug,
            discountType: pricing.discountType,
            discountPercentage: pricing.discountPercentage,
            discountAmount: pricing.discountAmount,
            discountedPrice: pricing.effectivePrice,
            maxBuyerPrice: pricing.maxBuyerPrice,
            hasVariants: pricing.hasCustomerOptions,
            availableForSale: pricing.availableForSale,
            freeDelivery: products.freeDelivery,
        }).from(products).innerJoin(pricing, eq(products.id, pricing.productId))
            .where(relatedConditions).orderBy(asc(products.id))
            .limit(Math.min(limit, 6 - query.offset)).offset(query.offset),
        db.select({ total: count() }).from(products).where(relatedConditions).get()])
        : [[], undefined];
    const mediaRows = rows.length
        ? await selectCheckoutProductMediaProjectionRows(db, rows.map((row) => row.id), [])
        : [];
    const mediaMap = resolveProductMediaProjectionRows(
        mediaRows as unknown as ProductMediaProjectionRow[],
    );
    const items = rows.map(({ maxBuyerPrice, ...row }) => {
        const image = resolveProductImageRepresentation(mediaMap.get(row.id) ?? []);
        return {
            ...row,
            hasVariants: Boolean(row.hasVariants),
            availableForSale: Boolean(row.availableForSale),
            priceVaries: maxBuyerPrice > row.discountedPrice,
            imageUrl: image?.url ?? null,
            imageMediaId: image?.mediaId ?? null,
            imageAlt: image?.altText ?? null,
        };
    });
    const total = Math.min(6, Number(relatedCountRow?.total ?? 0));
    return assertBoundedResult({
        section: "related_products" as const,
        items,
        ...pagination(total, query.offset, query.limit, 10),
    });
}
