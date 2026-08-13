import type { BatchItem } from "drizzle-orm/batch";
import { nanoid } from "nanoid";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import {
    categories,
    media,
    productAttributes,
    productAttributeValues,
    productMedia,
    productOptionDefinitions,
    productOptionValues,
    productRichContent,
    products,
    productVariantOptionValues,
    productVariants,
} from "@scalius/database/schema";
import { ValidationError } from "@scalius/core/errors";
import {
    isValidResourceCanonicalPath,
    normalizeCanonicalPathInput,
} from "@scalius/shared/seo-canonical";
import { PRODUCT_CONDITION_VALUES } from "@scalius/shared/product-condition";
import { defaultProductSkuValues } from "./products.public-eligibility";
import { executeProductAggregateMutationBatch } from "./products.aggregate-revision";
import { updateProductMediaSection } from "./products.admin";
import { MAX_PRODUCT_MEDIA_ASSOCIATIONS } from "./products.media";
import { MAX_PRODUCT_PRICE } from "./products.types";
import {
    productMediaAssociationIdSchema,
    productMediaInputSchema,
} from "./products.validation";
import { z } from "zod";

export const PRODUCT_SEMANTIC_TEXT_CHUNK_MAX = 12_000;
export const PRODUCT_SEMANTIC_RESULT_MAX_BYTES = 60 * 1024;
const PRODUCT_SEMANTIC_VARIANT_PAGE_MAX = 10;
const PRODUCT_SEMANTIC_MEDIA_PAGE_MAX = 20;
const PRODUCT_SEMANTIC_LIST_PAGE_MAX = 50;
const PRODUCT_ATTRIBUTE_INSERT_CHUNK = 18;

export const productSemanticSectionSchema = z.enum([
    "base",
    "text",
    "media",
    "attributes",
    "additional_info",
    "additional_info_text",
    "options",
    "variants",
]);

export const productSemanticSectionQuerySchema = z.object({
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    field: z.enum(["description", "metaTitle", "metaDescription", "title", "content"]).optional(),
    itemId: z.string().trim().min(1).max(180).optional(),
});

const canonicalPathPatchSchema = z
    .string()
    .nullable()
    .transform((value) => normalizeCanonicalPathInput(value))
    .refine(
        (value) => value === null || isValidResourceCanonicalPath("product", value),
        { message: "Canonical path must be a product route such as /products/main-shoe." },
    )
    .optional();

const productBasePatchSchema = z.object({
    name: z.string().min(3).max(100).optional(),
    price: z.number().min(0).max(MAX_PRODUCT_PRICE).optional(),
    categoryId: z.string().min(1).nullable().optional(),
    isActive: z.boolean().optional(),
    discountType: z.enum(["percentage", "flat"]).optional(),
    discountPercentage: z.number().min(0).max(100).nullable().optional(),
    discountAmount: z.number().min(0).max(MAX_PRODUCT_PRICE).nullable().optional(),
    freeDelivery: z.boolean().optional(),
    canonicalPath: canonicalPathPatchSchema,
    noIndex: z.boolean().optional(),
    excludeFromSitemap: z.boolean().optional(),
    excludeFromProductFeed: z.boolean().optional(),
    productCondition: z.enum(PRODUCT_CONDITION_VALUES).nullable().optional(),
    slug: z.string().min(3).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
}).refine(
    (patch) => Object.values(patch).some((value) => value !== undefined),
    "Provide at least one base field.",
);

const productAttributeAssignmentsSchema = z.array(z.object({
    attributeId: z.string().trim().min(1).max(100),
    value: z.string().trim().min(1).max(100),
})).max(90).superRefine((assignments, context) => {
    const ids = new Set<string>();
    assignments.forEach((assignment, index) => {
        const identity = assignment.attributeId.toLowerCase();
        if (ids.has(identity)) {
            context.addIssue({
                code: "custom",
                path: [index, "attributeId"],
                message: "Each attribute can be assigned only once.",
            });
        }
        ids.add(identity);
    });
});

const productRichContentIdSchema = z.string()
    .trim()
    .min(10)
    .max(180)
    .regex(/^prc_[A-Za-z0-9_-]+$/u, "Additional information item ID is invalid.");

const boundedTextRangeSchema = {
    offset: z.number().int().min(0).max(100_000),
    deleteCount: z.number().int().min(0).max(100_000),
    value: z.string().max(PRODUCT_SEMANTIC_TEXT_CHUNK_MAX).nullable(),
} as const;

export const productSemanticSectionPatchSchema = z.discriminatedUnion("section", [
    z.object({
        section: z.literal("base"),
        expectedAggregateRevision: z.number().int().min(1),
        patch: productBasePatchSchema,
    }),
    z.object({
        section: z.literal("text"),
        expectedAggregateRevision: z.number().int().min(1),
        field: z.enum(["description", "metaTitle", "metaDescription"]),
        ...boundedTextRangeSchema,
    }).superRefine((input, context) => {
        if (input.value === null && (input.offset !== 0 || input.deleteCount !== 0)) {
            context.addIssue({
                code: "custom",
                path: ["value"],
                message: "Use offset 0 and deleteCount 0 when setting a text field to null.",
            });
        }
    }),
    z.object({
        section: z.literal("media"),
        expectedAggregateRevision: z.number().int().min(1),
        media: productMediaInputSchema,
        acknowledgedSkuImageRemovalIds: z.array(productMediaAssociationIdSchema)
            .max(MAX_PRODUCT_MEDIA_ASSOCIATIONS)
            .optional(),
    }),
    z.object({
        section: z.literal("attributes"),
        expectedAggregateRevision: z.number().int().min(1),
        attributes: productAttributeAssignmentsSchema,
    }),
    z.object({
        section: z.literal("additional_info"),
        expectedAggregateRevision: z.number().int().min(1),
        action: z.enum(["create", "delete", "set_sort_order"]),
        itemId: productRichContentIdSchema,
        title: z.string().trim().min(1).max(PRODUCT_SEMANTIC_TEXT_CHUNK_MAX).optional(),
        content: z.string().trim().min(1).max(PRODUCT_SEMANTIC_TEXT_CHUNK_MAX).optional(),
        sortOrder: z.number().int().optional(),
    }).superRefine((input, context) => {
        if (input.action === "create" && (!input.title || !input.content || input.sortOrder === undefined)) {
            context.addIssue({
                code: "custom",
                message: "title, content, and sortOrder are required when creating an item.",
            });
        }
        if (input.action === "set_sort_order" && input.sortOrder === undefined) {
            context.addIssue({ code: "custom", path: ["sortOrder"], message: "sortOrder is required." });
        }
    }),
    z.object({
        section: z.literal("additional_info_text"),
        expectedAggregateRevision: z.number().int().min(1),
        itemId: productRichContentIdSchema,
        field: z.enum(["title", "content"]),
        offset: z.number().int().min(0).max(100_000),
        deleteCount: z.number().int().min(0).max(100_000),
        value: z.string().max(PRODUCT_SEMANTIC_TEXT_CHUNK_MAX),
    }),
]);

export type ProductSemanticSection = z.infer<typeof productSemanticSectionSchema>;
export type ProductSemanticSectionQuery = z.infer<typeof productSemanticSectionQuerySchema>;
export type ProductSemanticSectionPatch = z.infer<typeof productSemanticSectionPatchSchema>;
type ProductBasePatch = Extract<ProductSemanticSectionPatch, { section: "base" }>["patch"];
type ProductTextField = "description" | "metaTitle" | "metaDescription";
type SQLiteBatchItem = BatchItem<"sqlite">;

function chunkResult(value: string | null, totalCharacters: number, offset: number) {
    const text = value ?? "";
    const nextOffset = offset + text.length < totalCharacters ? offset + text.length : null;
    return { value: text, totalCharacters, offset, nextOffset, isNull: value === null };
}

function pageResult<T>(items: T[], total: number, offset: number, limit: number) {
    const nextOffset = offset + items.length < total ? offset + items.length : null;
    return { items, total, offset, limit, nextOffset };
}

function assertBoundedResult<T>(result: T): T {
    const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
    if (bytes > PRODUCT_SEMANTIC_RESULT_MAX_BYTES) {
        throw new ValidationError("The requested product section exceeds its bounded response. Use a smaller limit.");
    }
    return result;
}

function textColumn(field: ProductTextField) {
    if (field === "description") return products.description;
    if (field === "metaTitle") return products.metaTitle;
    return products.metaDescription;
}

async function readProductTextChunk(
    db: Database,
    productId: string,
    field: ProductTextField,
    offset: number,
) {
    const column = textColumn(field);
    return db.select({
        aggregateRevision: products.aggregateRevision,
        value: sql<string>`substr(coalesce(${column}, ''), ${offset + 1}, ${PRODUCT_SEMANTIC_TEXT_CHUNK_MAX})`,
        totalCharacters: sql<number>`length(coalesce(${column}, ''))`,
        isNull: sql<number>`CASE WHEN ${column} IS NULL THEN 1 ELSE 0 END`,
    }).from(products).where(eq(products.id, productId)).get();
}

async function readProductRevisionAndTotal(
    db: Database,
    productId: string,
    total: ReturnType<typeof sql<number>>,
) {
    return db.select({
        aggregateRevision: products.aggregateRevision,
        total,
    }).from(products).where(eq(products.id, productId)).get();
}

export async function getProductSemanticSection(
    db: Database,
    productId: string,
    section: ProductSemanticSection,
    query: ProductSemanticSectionQuery,
) {
    if (section === "base") {
        const row = await db.select({
            id: products.id,
            aggregateRevision: products.aggregateRevision,
            name: products.name,
            price: products.price,
            categoryId: products.categoryId,
            categoryName: categories.name,
            slug: products.slug,
            canonicalPath: products.canonicalPath,
            noIndex: products.noIndex,
            excludeFromSitemap: products.excludeFromSitemap,
            excludeFromProductFeed: products.excludeFromProductFeed,
            productCondition: products.productCondition,
            isActive: products.isActive,
            discountType: products.discountType,
            discountPercentage: products.discountPercentage,
            discountAmount: products.discountAmount,
            freeDelivery: products.freeDelivery,
            createdAt: products.createdAt,
            updatedAt: products.updatedAt,
            deletedAt: products.deletedAt,
            descriptionLength: sql<number>`length(coalesce(${products.description}, ''))`,
            metaTitleLength: sql<number>`length(coalesce(${products.metaTitle}, ''))`,
            metaDescriptionLength: sql<number>`length(coalesce(${products.metaDescription}, ''))`,
            mediaCount: sql<number>`(
                SELECT count(*) FROM ${productMedia}
                INNER JOIN ${media} ON ${media.id} = ${productMedia.mediaId}
                WHERE ${productMedia.productId} = ${sql.raw('"products"."id"')}
                  AND ${media.status} IN ('ready', 'trashed')
            )`,
            attributeCount: sql<number>`(SELECT count(*) FROM ${productAttributeValues} WHERE ${productAttributeValues.productId} = ${sql.raw('"products"."id"')})`,
            additionalInfoCount: sql<number>`(SELECT count(*) FROM ${productRichContent} WHERE ${productRichContent.productId} = ${sql.raw('"products"."id"')})`,
            optionCount: sql<number>`(SELECT count(*) FROM ${productOptionDefinitions} WHERE ${productOptionDefinitions.productId} = ${sql.raw('"products"."id"')} AND ${productOptionDefinitions.deletedAt} IS NULL)`,
            variantCount: sql<number>`(SELECT count(*) FROM ${productVariants} WHERE ${productVariants.productId} = ${sql.raw('"products"."id"')} AND ${productVariants.deletedAt} IS NULL)`,
        }).from(products).leftJoin(categories, eq(categories.id, products.categoryId))
            .where(eq(products.id, productId)).get();
        if (!row) return null;
        return assertBoundedResult({
            section,
            aggregateRevision: row.aggregateRevision,
            product: {
                id: row.id,
                name: row.name,
                price: row.price,
                categoryId: row.categoryId,
                categoryName: row.categoryName ?? null,
                slug: row.slug,
                canonicalPath: row.canonicalPath,
                noIndex: row.noIndex,
                excludeFromSitemap: row.excludeFromSitemap,
                excludeFromProductFeed: row.excludeFromProductFeed,
                productCondition: row.productCondition,
                isActive: row.isActive,
                discountType: row.discountType,
                discountPercentage: row.discountPercentage,
                discountAmount: row.discountAmount,
                freeDelivery: row.freeDelivery,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                deletedAt: row.deletedAt,
                textLengths: {
                    description: row.descriptionLength,
                    metaTitle: row.metaTitleLength,
                    metaDescription: row.metaDescriptionLength,
                },
                counts: {
                    media: row.mediaCount,
                    attributes: row.attributeCount,
                    additionalInfo: row.additionalInfoCount,
                    options: row.optionCount,
                    variants: row.variantCount,
                },
            },
        });
    }

    if (section === "text") {
        if (!query.field || !["description", "metaTitle", "metaDescription"].includes(query.field)) {
            throw new ValidationError("field must be description, metaTitle, or metaDescription for the text section.");
        }
        const field = query.field as ProductTextField;
        const row = await readProductTextChunk(db, productId, field, query.offset);
        if (!row) return null;
        return assertBoundedResult({
            section,
            field,
            aggregateRevision: row.aggregateRevision,
            ...chunkResult(row.isNull ? null : row.value, row.totalCharacters, query.offset),
        });
    }

    if (section === "media") {
        const limit = Math.min(query.limit, PRODUCT_SEMANTIC_MEDIA_PAGE_MAX);
        const header = await readProductRevisionAndTotal(db, productId, sql<number>`(
            SELECT count(*) FROM ${productMedia}
            INNER JOIN ${media}
              ON ${sql.raw('"media"."id"')} = ${sql.raw('"product_media"."media_id"')}
            WHERE ${sql.raw('"product_media"."product_id"')} = ${sql.raw('"products"."id"')}
              AND ${sql.raw('"media"."status"')} IN ('ready', 'trashed')
        )`);
        if (!header) return null;
        const items = await db.select({
            id: productMedia.id,
            mediaId: productMedia.mediaId,
            altText: productMedia.altText,
            isPrimary: productMedia.isPrimary,
            sortOrder: productMedia.sortOrder,
        }).from(productMedia).innerJoin(media, eq(media.id, productMedia.mediaId))
            .where(and(eq(productMedia.productId, productId), inArray(media.status, ["ready", "trashed"])))
            .orderBy(asc(productMedia.sortOrder), asc(productMedia.id))
            .limit(limit).offset(query.offset).all();
        return assertBoundedResult({ section, aggregateRevision: header.aggregateRevision, ...pageResult(items, header.total, query.offset, limit) });
    }

    if (section === "attributes") {
        const limit = Math.min(query.limit, PRODUCT_SEMANTIC_LIST_PAGE_MAX);
        const header = await readProductRevisionAndTotal(
            db,
            productId,
            sql<number>`(SELECT count(*) FROM ${productAttributeValues} WHERE ${productAttributeValues.productId} = ${sql.raw('"products"."id"')})`,
        );
        if (!header) return null;
        const items = await db.select({
            attributeId: productAttributeValues.attributeId,
            value: productAttributeValues.value,
        }).from(productAttributeValues).where(eq(productAttributeValues.productId, productId))
            .orderBy(asc(productAttributeValues.attributeId)).limit(limit).offset(query.offset).all();
        return assertBoundedResult({ section, aggregateRevision: header.aggregateRevision, ...pageResult(items, header.total, query.offset, limit) });
    }

    if (section === "additional_info") {
        const limit = Math.min(query.limit, PRODUCT_SEMANTIC_LIST_PAGE_MAX);
        const header = await readProductRevisionAndTotal(
            db,
            productId,
            sql<number>`(SELECT count(*) FROM ${productRichContent} WHERE ${productRichContent.productId} = ${sql.raw('"products"."id"')})`,
        );
        if (!header) return null;
        const rows = await db.select({
            id: productRichContent.id,
            sortOrder: productRichContent.sortOrder,
            titleCharacters: sql<number>`length(${productRichContent.title})`,
            contentCharacters: sql<number>`length(${productRichContent.content})`,
        }).from(productRichContent).where(eq(productRichContent.productId, productId))
            .orderBy(asc(productRichContent.sortOrder), asc(productRichContent.id))
            .limit(limit).offset(query.offset).all();
        return assertBoundedResult({ section, aggregateRevision: header.aggregateRevision, ...pageResult(rows, header.total, query.offset, limit) });
    }

    if (section === "additional_info_text") {
        if (!query.itemId || (query.field !== "title" && query.field !== "content")) {
            throw new ValidationError("itemId and field=title|content are required for additional_info_text.");
        }
        const column = query.field === "title" ? productRichContent.title : productRichContent.content;
        const row = await db.select({
            aggregateRevision: products.aggregateRevision,
            itemId: productRichContent.id,
            sortOrder: productRichContent.sortOrder,
            value: sql<string>`substr(${column}, ${query.offset + 1}, ${PRODUCT_SEMANTIC_TEXT_CHUNK_MAX})`,
            totalCharacters: sql<number>`length(${column})`,
        }).from(products).innerJoin(productRichContent, eq(productRichContent.productId, products.id))
            .where(and(eq(products.id, productId), eq(productRichContent.id, query.itemId))).get();
        if (!row) {
            const product = await db.select({ id: products.id }).from(products).where(eq(products.id, productId)).get();
            if (!product) return null;
            throw new ValidationError("Additional information item not found.");
        }
        return assertBoundedResult({
            section,
            itemId: row.itemId,
            field: query.field,
            sortOrder: row.sortOrder,
            aggregateRevision: row.aggregateRevision,
            ...chunkResult(row.value, row.totalCharacters, query.offset),
        });
    }

    if (section === "options") {
        const header = await readProductRevisionAndTotal(
            db,
            productId,
            sql<number>`(SELECT count(*) FROM ${productOptionDefinitions} WHERE ${productOptionDefinitions.productId} = ${sql.raw('"products"."id"')} AND ${productOptionDefinitions.deletedAt} IS NULL)`,
        );
        if (!header) return null;
        const definitions = await db.select({
            id: productOptionDefinitions.id,
            name: productOptionDefinitions.name,
            position: productOptionDefinitions.position,
            standardMapping: productOptionDefinitions.standardMapping,
        }).from(productOptionDefinitions).where(and(
            eq(productOptionDefinitions.productId, productId),
            isNull(productOptionDefinitions.deletedAt),
        )).orderBy(asc(productOptionDefinitions.position), asc(productOptionDefinitions.id))
            .limit(1).offset(query.offset).all();
        const definition = definitions[0];
        const values = definition ? await db.select({
            id: productOptionValues.id,
            value: productOptionValues.value,
            position: productOptionValues.position,
        }).from(productOptionValues).where(and(
            eq(productOptionValues.optionDefinitionId, definition.id),
            isNull(productOptionValues.deletedAt),
        )).orderBy(asc(productOptionValues.position), asc(productOptionValues.id)).limit(150).all() : [];
        const items = definition ? [{ ...definition, values }] : [];
        return assertBoundedResult({ section, aggregateRevision: header.aggregateRevision, ...pageResult(items, header.total, query.offset, 1) });
    }

    const limit = Math.min(query.limit, PRODUCT_SEMANTIC_VARIANT_PAGE_MAX);
    const header = await readProductRevisionAndTotal(
        db,
        productId,
        sql<number>`(SELECT count(*) FROM ${productVariants} WHERE ${productVariants.productId} = ${sql.raw('"products"."id"')} AND ${productVariants.deletedAt} IS NULL)`,
    );
    if (!header) return null;
    const variants = await db.select({
        id: productVariants.id,
        imageId: productVariants.imageId,
        weight: productVariants.weight,
        sku: productVariants.sku,
        price: productVariants.price,
        stock: productVariants.stock,
        trackInventory: productVariants.trackInventory,
        barcode: productVariants.barcode,
        barcodeType: productVariants.barcodeType,
        discountType: productVariants.discountType,
        discountPercentage: productVariants.discountPercentage,
        discountAmount: productVariants.discountAmount,
    }).from(productVariants).where(and(
        eq(productVariants.productId, productId),
        isNull(productVariants.deletedAt),
    )).orderBy(asc(productVariants.createdAt), asc(productVariants.id))
        .limit(limit).offset(query.offset).all();
    const variantIds = variants.map((variant) => variant.id);
    const selections = variantIds.length === 0 ? [] : await db.select({
        variantId: productVariantOptionValues.variantId,
        optionDefinitionId: productVariantOptionValues.optionDefinitionId,
        optionValueId: productVariantOptionValues.optionValueId,
        name: productOptionDefinitions.name,
        value: productOptionValues.value,
        position: productOptionDefinitions.position,
        valuePosition: productOptionValues.position,
        standardMapping: productOptionDefinitions.standardMapping,
    }).from(productVariantOptionValues)
        .innerJoin(productOptionDefinitions, eq(productOptionDefinitions.id, productVariantOptionValues.optionDefinitionId))
        .innerJoin(productOptionValues, eq(productOptionValues.id, productVariantOptionValues.optionValueId))
        .where(and(
            inArray(productVariantOptionValues.variantId, variantIds),
            isNull(productOptionDefinitions.deletedAt),
            isNull(productOptionValues.deletedAt),
        )).orderBy(
            asc(productVariantOptionValues.variantId),
            asc(productOptionDefinitions.position),
            asc(productOptionValues.position),
        ).all();
    const selectedByVariant = new Map<string, typeof selections>();
    for (const selection of selections) {
        const values = selectedByVariant.get(selection.variantId) ?? [];
        values.push(selection);
        selectedByVariant.set(selection.variantId, values);
    }
    const items = variants.map((variant) => {
        const selectedOptions = (selectedByVariant.get(variant.id) ?? []).map(({ variantId: _variantId, ...selection }) => selection);
        return {
            ...variant,
            selectedOptionValueIds: selectedOptions.map((option) => option.optionValueId),
            selectedOptions,
        };
    });
    return assertBoundedResult({ section: "variants" as const, aggregateRevision: header.aggregateRevision, ...pageResult(items, header.total, query.offset, limit) });
}

function applyTextRange(
    current: string | null,
    offset: number,
    deleteCount: number,
    value: string | null,
    fieldName: string,
) {
    if (value === null) return null;
    const text = current ?? "";
    if (offset > text.length || deleteCount > text.length - offset) {
        throw new ValidationError(`${fieldName} text range is outside the current value.`);
    }
    const next = text.slice(0, offset) + value + text.slice(offset + deleteCount);
    if (next.length > 100_000) {
        throw new ValidationError(`${fieldName} must contain at most 100000 characters.`);
    }
    return next;
}

async function updateBaseSection(
    db: Database,
    productId: string,
    expectedAggregateRevision: number,
    patch: ProductBasePatch,
) {
    const current = await db.select({
        name: products.name,
        price: products.price,
        categoryId: products.categoryId,
        isActive: products.isActive,
        discountType: products.discountType,
        discountPercentage: products.discountPercentage,
        discountAmount: products.discountAmount,
        freeDelivery: products.freeDelivery,
        canonicalPath: products.canonicalPath,
        noIndex: products.noIndex,
        excludeFromSitemap: products.excludeFromSitemap,
        excludeFromProductFeed: products.excludeFromProductFeed,
        productCondition: products.productCondition,
        slug: products.slug,
    }).from(products).where(eq(products.id, productId)).get();
    if (!current) return null;
    const definedPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    const next = { ...current, ...definedPatch } as typeof current;
    if (next.canonicalPath !== null && next.canonicalPath !== `/products/${next.slug}`) {
        throw new ValidationError("Canonical path must use this product's current slug until URL aliases are supported.");
    }
    if (next.slug !== current.slug) {
        const collision = await db.select({ id: products.id }).from(products).where(and(
            eq(products.slug, next.slug),
            sql`${products.id} != ${productId}`,
            isNull(products.deletedAt),
        )).get();
        if (collision) throw new ValidationError("A product with this slug already exists.");
    }

    const mutationStatements: SQLiteBatchItem[] = [db.update(products).set({
        name: next.name,
        price: next.price,
        categoryId: next.categoryId,
        isActive: next.isActive,
        discountType: next.discountType ?? "percentage",
        discountPercentage: (next.discountType ?? "percentage") === "percentage" ? next.discountPercentage : 0,
        discountAmount: (next.discountType ?? "percentage") === "flat" ? next.discountAmount : 0,
        freeDelivery: next.freeDelivery,
        canonicalPath: next.canonicalPath,
        noIndex: next.noIndex,
        excludeFromSitemap: next.excludeFromSitemap,
        excludeFromProductFeed: next.excludeFromProductFeed,
        productCondition: next.productCondition,
        slug: next.slug,
    }).where(eq(products.id, productId))];

    if (patch.price !== undefined || patch.isActive !== undefined) {
        const topology = await db.select({
            total: sql<number>`count(*)`,
            defaultCount: sql<number>`sum(CASE WHEN ${productVariants.isDefault} = 1 THEN 1 ELSE 0 END)`,
            invalidCount: sql<number>`sum(CASE WHEN ${productVariants.isDefault} = 0 AND trim(coalesce(${productVariants.optionCombinationKey}, '')) = '' THEN 1 ELSE 0 END)`,
        }).from(productVariants).where(and(
            eq(productVariants.productId, productId),
            isNull(productVariants.deletedAt),
        )).get();
        const total = topology?.total ?? 0;
        const defaultCount = topology?.defaultCount ?? 0;
        const invalidCount = topology?.invalidCount ?? 0;
        if (defaultCount > 0 && !(total === 1 && defaultCount === 1 && invalidCount === 0)) {
            throw new ValidationError("Product SKU data is invalid: only one default SKU is allowed, and every non-default SKU must include at least one customer option.");
        }
        if (invalidCount > 0) {
            throw new ValidationError("Product SKU data is invalid: only one default SKU is allowed, and every non-default SKU must include at least one customer option.");
        }
        if (next.isActive && total === 0) {
            mutationStatements.push(db.insert(productVariants).values(defaultProductSkuValues(productId, next.price)));
        } else if (total === 1 && defaultCount === 1) {
            mutationStatements.push(db.update(productVariants).set({
                price: next.price,
                discountType: "percentage",
                discountPercentage: 0,
                discountAmount: 0,
                updatedAt: sql`unixepoch()`,
            }).where(and(
                eq(productVariants.productId, productId),
                eq(productVariants.isDefault, true),
                isNull(productVariants.deletedAt),
            )));
        }
    }
    const result = await executeProductAggregateMutationBatch(db, productId, expectedAggregateRevision, mutationStatements);
    return { aggregateRevision: result.aggregateRevision };
}

async function updateTextSection(
    db: Database,
    productId: string,
    patch: Extract<ProductSemanticSectionPatch, { section: "text" }>,
) {
    const column = textColumn(patch.field);
    const row = await db.select({ value: column }).from(products).where(eq(products.id, productId)).get();
    if (!row) return null;
    const value = applyTextRange(row.value, patch.offset, patch.deleteCount, patch.value, patch.field);
    if (patch.field === "description" && value !== null && value.length < 10) {
        throw new ValidationError("Description must contain at least 10 characters.");
    }
    const values = patch.field === "description"
        ? { description: value }
        : patch.field === "metaTitle"
            ? { metaTitle: value }
            : { metaDescription: value };
    const result = await executeProductAggregateMutationBatch(
        db,
        productId,
        patch.expectedAggregateRevision,
        [db.update(products).set(values).where(eq(products.id, productId))],
    );
    return { aggregateRevision: result.aggregateRevision };
}

async function updateAttributesSection(
    db: Database,
    productId: string,
    patch: Extract<ProductSemanticSectionPatch, { section: "attributes" }>,
) {
    const product = await db.select({ id: products.id }).from(products).where(eq(products.id, productId)).get();
    if (!product) return null;
    const attributeIds = [...new Set(patch.attributes.map((item) => item.attributeId))];
    const active = attributeIds.length === 0 ? [] : await db.select({ id: productAttributes.id })
        .from(productAttributes).where(and(
            isNull(productAttributes.deletedAt),
            sql`${productAttributes.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(attributeIds)}))`,
        )).all();
    if (active.length !== attributeIds.length) {
        throw new ValidationError("One or more assigned attributes are unavailable or in trash. Remove them and try again.");
    }
    const statements: SQLiteBatchItem[] = [
        db.delete(productAttributeValues).where(eq(productAttributeValues.productId, productId)),
    ];
    for (let index = 0; index < patch.attributes.length; index += PRODUCT_ATTRIBUTE_INSERT_CHUNK) {
        statements.push(db.insert(productAttributeValues).values(
            patch.attributes.slice(index, index + PRODUCT_ATTRIBUTE_INSERT_CHUNK).map((item) => ({
                id: `val_${nanoid()}`,
                productId,
                attributeId: item.attributeId,
                value: item.value,
            })),
        ));
    }
    const result = await executeProductAggregateMutationBatch(
        db,
        productId,
        patch.expectedAggregateRevision,
        statements,
    );
    return { aggregateRevision: result.aggregateRevision };
}

async function updateAdditionalInfoSection(
    db: Database,
    productId: string,
    patch: Extract<ProductSemanticSectionPatch, { section: "additional_info" }>,
) {
    const product = await db.select({ id: products.id }).from(products).where(eq(products.id, productId)).get();
    if (!product) return null;
    const existing = await db.select({
        id: productRichContent.id,
        productId: productRichContent.productId,
    }).from(productRichContent).where(eq(productRichContent.id, patch.itemId)).get();
    if (patch.action === "create" && existing) {
        throw new ValidationError("Additional information item already exists.");
    }
    if (patch.action !== "create" && existing?.productId !== productId) {
        throw new ValidationError("Additional information item not found.");
    }
    const statement = patch.action === "create"
        ? db.insert(productRichContent).values({
            id: patch.itemId,
            productId,
            title: patch.title!,
            content: patch.content!,
            sortOrder: patch.sortOrder!,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        })
        : patch.action === "delete"
            ? db.delete(productRichContent).where(and(
                eq(productRichContent.id, patch.itemId),
                eq(productRichContent.productId, productId),
            ))
            : db.update(productRichContent).set({
                sortOrder: patch.sortOrder!,
                updatedAt: sql`unixepoch()`,
            }).where(and(
                eq(productRichContent.id, patch.itemId),
                eq(productRichContent.productId, productId),
            ));
    const result = await executeProductAggregateMutationBatch(
        db,
        productId,
        patch.expectedAggregateRevision,
        [statement],
    );
    return { aggregateRevision: result.aggregateRevision };
}

async function updateAdditionalInfoTextSection(
    db: Database,
    productId: string,
    patch: Extract<ProductSemanticSectionPatch, { section: "additional_info_text" }>,
) {
    const column = patch.field === "title" ? productRichContent.title : productRichContent.content;
    const item = await db.select({ value: column }).from(productRichContent).where(and(
        eq(productRichContent.id, patch.itemId),
        eq(productRichContent.productId, productId),
    )).get();
    if (!item) {
        const product = await db.select({ id: products.id }).from(products).where(eq(products.id, productId)).get();
        if (!product) return null;
        throw new ValidationError("Additional information item not found.");
    }
    const value = applyTextRange(item.value, patch.offset, patch.deleteCount, patch.value, patch.field);
    if (!value?.trim()) throw new ValidationError(`Additional information ${patch.field} cannot be empty.`);
    const values = patch.field === "title" ? { title: value } : { content: value };
    const result = await executeProductAggregateMutationBatch(
        db,
        productId,
        patch.expectedAggregateRevision,
        [db.update(productRichContent).set({ ...values, updatedAt: sql`unixepoch()` }).where(and(
            eq(productRichContent.id, patch.itemId),
            eq(productRichContent.productId, productId),
        ))],
    );
    return { aggregateRevision: result.aggregateRevision };
}

export async function updateProductSemanticSection(
    db: Database,
    productId: string,
    patch: ProductSemanticSectionPatch,
) {
    if (patch.section === "base") {
        return updateBaseSection(db, productId, patch.expectedAggregateRevision, patch.patch);
    }
    if (patch.section === "text") return updateTextSection(db, productId, patch);
    if (patch.section === "media") {
        return updateProductMediaSection(
            db,
            productId,
            patch.expectedAggregateRevision,
            patch.media,
            patch.acknowledgedSkuImageRemovalIds,
        );
    }
    if (patch.section === "attributes") return updateAttributesSection(db, productId, patch);
    if (patch.section === "additional_info") return updateAdditionalInfoSection(db, productId, patch);
    return updateAdditionalInfoTextSection(db, productId, patch);
}
