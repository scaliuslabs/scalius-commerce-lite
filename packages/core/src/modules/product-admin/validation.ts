// src/modules/products/products.validation.ts
// Zod schemas for product create/update operations.
// Imported by both admin API routes and service methods.

import { isSalesChannelId, SALES_CHANNEL_ID_MAX_LENGTH } from "@scalius/shared/sales-channels";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
    isValidResourceCanonicalPath,
    normalizeCanonicalPathInput,
} from "@scalius/shared/seo-canonical";
import {
    PRODUCT_CONDITION_VALUES,
} from "@scalius/shared/product-condition";
import { isBrandId } from "@scalius/shared/catalog-brand";
import {
  addGiftCardInputIssues,
  catalogMoneySchema,
  customizationSchemaInputSchema,
  DIGITAL_STOCK_IS_KEYS_REASON,
  digitalStockInputIssues,
  editableFulfillmentKindSchema,
  expectedStockVersionSchema,
  MAX_PRODUCT_MEDIA_ASSOCIATIONS,
  productBundleTierInputListSchema,
  productContentBlockInputListSchema,
  skuStockSchema,
  skuWeightSchema,
} from "../products";
import { createProductOptionMatrixSchema, productOptionMatrixBodySchema } from "./option-matrix";
import { unitCostAmountSchema } from "../inventory";
import { templateAssignmentSchema } from "@scalius/shared/catalog-tree";
import { MAX_PRODUCT_OPTION_COMBINATIONS } from "@scalius/shared/product-options";

const canonicalPathSchema = z
    .string()
    .nullable()
    .optional()
    .transform((value) => normalizeCanonicalPathInput(value))
    .refine((value) => value === null || isValidResourceCanonicalPath("product", value), {
        message: "Canonical path must be a product route such as /products/main-shoe.",
    });

const productConditionSchema = z.enum(PRODUCT_CONDITION_VALUES);

/** A live brand's id; null clears the product's brand. */
export const productBrandIdSchema = z
    .string()
    .trim()
    .refine(isBrandId, "Choose a brand from the list.")
    .nullable();

export const productMediaAssociationIdSchema = z.string()
    .trim()
    .min(10)
    .max(80)
    .regex(
        /^pmed_[A-Za-z0-9_-]+$/u,
        "Expected this product's own attachment id: pmed_ followed by letters, digits, _ or -. It is not the media file's id (that goes in mediaId).",
    );

const globalMediaIdSchema = z.string()
    .trim()
    .min(8)
    .max(160)
    .regex(/^[A-Za-z0-9_-]+$/u, "Media ID is invalid.")
    .describe("The media file's id: the id a media upload or URL import returns.");

const altTextSchema = z.string().trim().max(500).nullable()
    .transform((value) => value?.trim() ? value.trim() : null);

type MediaListItem = { id?: string; mediaId: string; isPrimary?: boolean };

/** Unique attachments and files; at most one featured item, and exactly one once every item says. */
function productMediaListIssues(items: readonly MediaListItem[], context: z.RefinementCtx): void {
    const ids = new Set<string>();
    const mediaIds = new Set<string>();
    let primaryCount = 0;
    items.forEach((item, index) => {
        if (item.id !== undefined && ids.has(item.id)) {
            context.addIssue({ code: "custom", path: [index, "id"], message: "Each product media association ID must be unique." });
        }
        if (mediaIds.has(item.mediaId)) {
            context.addIssue({ code: "custom", path: [index, "mediaId"], message: "The same media asset can be attached only once." });
        }
        if (item.id !== undefined) ids.add(item.id);
        mediaIds.add(item.mediaId);
        if (item.isPrimary === true) primaryCount += 1;
    });
    const unsaid = items.some((item) => item.isPrimary === undefined);
    if (items.length > 0 && (primaryCount > 1 || (primaryCount === 0 && !unsaid))) {
        context.addIssue({
            code: "custom",
            message: "Choose exactly one featured media item.",
            path: [Math.max(0, items.findIndex((item) => item.isPrimary)), "isPrimary"],
        });
    }
}

/** Ordered product association contract; request order becomes dense sortOrder. */
export const productMediaInputSchema = z.array(z.object({
    id: productMediaAssociationIdSchema,
    mediaId: globalMediaIdSchema,
    altText: altTextSchema,
    isPrimary: z.boolean(),
})).max(
    MAX_PRODUCT_MEDIA_ASSOCIATIONS,
    `Attach at most ${MAX_PRODUCT_MEDIA_ASSOCIATIONS} media items to a product.`,
).superRefine(productMediaListIssues);

/**
 * A new product's media: the files by `mediaId` (the id a media upload
 * returns). The attachment `id` (pmed_) is needed only when a SKU's imageId
 * names it; omitted, one is made. Without a featured item the first is.
 */
export const createProductMediaInputSchema = z.array(z.object({
    id: productMediaAssociationIdSchema.optional()
        .describe("Optional pmed_ id of your choosing, for a SKU's imageId to name this attachment. Omit it and one is made."),
    mediaId: globalMediaIdSchema,
    altText: altTextSchema.optional(),
    isPrimary: z.boolean().optional().describe("The featured image. Omit on every item and the first is featured."),
})).max(
    MAX_PRODUCT_MEDIA_ASSOCIATIONS,
    `Attach at most ${MAX_PRODUCT_MEDIA_ASSOCIATIONS} media items to a product.`,
).superRefine(productMediaListIssues).transform((items) => {
    const featured = items.some((item) => item.isPrimary === true)
        ? -1
        : items.findIndex((item) => item.isPrimary === undefined);
    return items.map((item, index) => ({
        id: item.id ?? `pmed_${nanoid()}`,
        mediaId: item.mediaId,
        altText: item.altText ?? null,
        isPrimary: item.isPrimary ?? index === featured,
    }));
});

/** A warranty policy id; the write checks it exists and is not archived. */
export const productWarrantyPolicyIdSchema = z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^wrp_[A-Za-z0-9_-]+$/u, "Choose a warranty policy from the list.");

/** Shared attribute schema used in create and update */
const productAttributeSchema = z.array(
    z.object({
        attributeId: z.string().trim().min(1).max(100),
        value: z.string().trim().min(1).max(100),
    }),
)
    .max(90, "Assign at most 90 attributes to a product")
    .superRefine((assignments, context) => {
        const seenAttributeIds = new Set<string>();
        assignments.forEach((assignment, index) => {
            const key = assignment.attributeId.toLowerCase();
            if (seenAttributeIds.has(key)) {
                context.addIssue({
                    code: "custom",
                    path: [index, "attributeId"],
                    message: "Each attribute can be assigned only once",
                });
            }
            seenAttributeIds.add(key);
        });
    })
    .optional();

/** Sales channel ids (`sc_online_store`, an app's `<plugin id>:<id>`), each once. */
export const productSalesChannelIdsSchema = z.array(
    z.string().max(SALES_CHANNEL_ID_MAX_LENGTH).refine(isSalesChannelId, "Use a sales channel id."),
).max(50).refine((ids) => new Set(ids).size === ids.length, "Name each sales channel once.");

/** Shared additional info schema used in create and update */
const productAdditionalInfoSchema = z.array(
    z.object({
        id: z.string(),
        title: z.string(),
        content: z.string(),
        sortOrder: z.number(),
    }),
).optional();

/** A product title is 1 to 255 characters, as Shopify's: "TV" is a title, and long Bangladesh listing titles fit. */
export const PRODUCT_NAME_MAX_LENGTH = 255;

/** Base product fields shared between create and update */
const productBaseSchema = z.object({
    name: z.string().trim().min(1).max(PRODUCT_NAME_MAX_LENGTH),
    /** Any length, empty included: the editor imposes no minimum. */
    description: z.string().nullable(),
    price: catalogMoneySchema,
    categoryId: z.string().min(1).nullable(),
    /** Omit to keep the product's brand; null removes it. */
    brandId: productBrandIdSchema.optional()
        .describe("A live brand id (brd_…). Omit to keep the current brand; null removes it."),
    isActive: z.boolean(),
    discountType: z.enum(["percentage", "flat"]).optional(),
    discountPercentage: z.number().min(0).max(100).nullish(),
    discountAmount: catalogMoneySchema.nullish(),
    freeDelivery: z.boolean(),
    metaTitle: z.string().nullable(),
    metaDescription: z.string().nullable().refine(
        (value) => !value?.includes("<!--variant_images:"),
        "Legacy variant-image metadata is not allowed. Assign images directly to SKUs.",
    ),
    canonicalPath: canonicalPathSchema,
    noIndex: z.boolean().optional().default(false),
    excludeFromSitemap: z.boolean().optional().default(false),
    productCondition: productConditionSchema.nullable(),
    slug: z
        .string()
        .min(3)
        .max(100)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    media: productMediaInputSchema,
    attributes: productAttributeSchema,
    additionalInfo: productAdditionalInfoSchema,
    /** Buyer inputs (engraving, gift wrap, a fit choice). Omit to keep; null to remove all. */
    customizationSchema: customizationSchemaInputSchema.nullable().optional(),
    /** Sets every live SKU's fulfilment kind at once (the Shipping card's select). Omit to keep. */
    fulfillmentKind: editableFulfillmentKindSchema.optional(),
    /** Gift-card product: every SKU is a digital, untracked, undiscounted denomination. Omit to keep (a new product is not). */
    isGiftCard: z.boolean().optional()
        .describe("Gift-card product: every SKU is a fixed denomination, delivered digitally, untracked and never discounted. Omit to keep."),
    /** A live warranty policy (wrp_…); null removes it. Omit to keep. */
    warrantyPolicyId: productWarrantyPolicyIdSchema.nullable().optional()
        .describe("A live warranty policy id (wrp_…). Omit to keep the current warranty; null removes it."),
});

function requireCanonicalProductHandle(
    value: { slug?: string; canonicalPath?: string | null },
    context: z.RefinementCtx,
): void {
    if (value.canonicalPath !== null && (value.slug === undefined || value.canonicalPath !== `/products/${value.slug}`)) {
        context.addIssue({
            code: "custom",
            path: ["canonicalPath"],
            message: "Canonical path must use this product's current slug until URL aliases are supported.",
        });
    }
}

/**
 * A product on sale needs a price customers can pay (feeds and checkout
 * reject non-positive prices), and a fixed discount can't exceed the price.
 */
function requireSellablePrice(
    value: { isActive: boolean; price: number; discountType?: "percentage" | "flat"; discountAmount?: number | null },
    context: z.RefinementCtx,
): void {
    if (value.isActive && value.price <= 0) {
        context.addIssue({ code: "custom", path: ["price"], message: "Enter a price above 0 to make this product active." });
    }
    if (value.discountType === "flat" && (value.discountAmount ?? 0) > value.price) {
        context.addIssue({ code: "custom", path: ["discountAmount"], message: "A discount can't be more than the price." });
    }
}

/** Inventory facts for the hidden SKU of a product created without options. */
const defaultSkuInputSchema = z.object({
    sku: z.string().trim().min(3).max(100).optional()
        .describe("Omit to generate a readable SKU from the product title."),
    trackInventory: z.boolean(),
    stock: skuStockSchema.describe("Initial on-hand quantity; must be 0 when inventory is not tracked."),
    barcode: z.string().trim().max(50).nullable().optional()
        .describe("Scanned or printed barcode. Omit or null to generate an internal Code 128 barcode."),
    barcodeType: z.enum(["ean13", "upc", "isbn", "gtin", "code128", "custom"]).nullable().optional(),
    weight: skuWeightSchema.nullable().optional(),
    fulfillmentKind: editableFulfillmentKindSchema.optional(),
    cost: unitCostAmountSchema.nullable().optional()
        .describe("Cost per item in major units of the store currency. Omit or null for none."),
}).refine((value) => value.trackInventory || value.stock === 0, {
    message: "Turn on quantity tracking before setting a quantity.",
    path: ["stock"],
});

/** Schema for creating a new product (POST /api/products) */
export const createProductSchema = productBaseSchema
    .extend({
        slug: productBaseSchema.shape.slug.optional()
            .describe("Omit to derive the web address from the name; a taken one gets a -2, -3… suffix."),
        productCondition: productConditionSchema,
        media: createProductMediaInputSchema.default([]),
        optionMatrix: createProductOptionMatrixSchema.optional(),
        defaultSku: defaultSkuInputSchema.optional()
            .describe("Inventory for a product without options. Omit for an untracked SKU. Not allowed with optionMatrix."),
        salesChannelIds: productSalesChannelIdsSchema.optional()
            .describe("The sales channels to publish the new product to. Omit to publish it to every channel."),
    })
    .superRefine(requireCanonicalProductHandle)
    .superRefine(requireSellablePrice)
    .superRefine((value, context) => {
        if (!value.isActive) return;
        value.optionMatrix?.variants.forEach((variant, index) => {
            if (variant.price <= 0) {
                context.addIssue({
                    code: "custom",
                    path: ["optionMatrix", "variants", index, "price"],
                    message: "Enter a price above 0 for every variant of an active product.",
                });
            }
        });
    })
    .superRefine(addGiftCardInputIssues)
    // A digital SKU's stock is its licence keys: it is created without a quantity.
    .superRefine((value, context) => {
        for (const issue of digitalStockInputIssues(value)) {
            context.addIssue({ code: "custom", path: issue.path, message: issue.message, params: { reason: DIGITAL_STOCK_IS_KEYS_REASON } });
        }
    })
    .refine((value) => !(value.optionMatrix && value.defaultSku), {
        message: "Send either optionMatrix or defaultSku, not both.",
        path: ["defaultSku"],
    });

/** Edits to the hidden SKU of a product without options, saved with the product. */
const defaultSkuUpdateSchema = z.object({
    sku: z.string().trim().min(3).max(100),
    trackInventory: z.boolean(),
    stock: skuStockSchema.optional()
        .describe("New on-hand quantity. Omit to keep the current quantity."),
    expectedStockVersion: expectedStockVersionSchema.optional(),
    barcode: z.string().trim().max(50).nullable(),
    barcodeType: z.enum(["ean13", "upc", "isbn", "gtin", "code128", "custom"]).nullable(),
    weight: skuWeightSchema.nullable(),
}).refine((value) => value.stock === undefined || value.expectedStockVersion !== undefined, {
    message: "Send expectedStockVersion with stock.",
    path: ["expectedStockVersion"],
});

/** A SKU's new cost per item, with the cost the editor showed (a receipt that moved it since refuses the save). */
const skuCostChangeSchema = z.object({
    /** A saved SKU's id, or a new row's id in this save's optionMatrix. */
    variantId: z.string().trim().min(1).max(100),
    cost: unitCostAmountSchema.nullable(),
    expectedCost: unitCostAmountSchema.nullable(),
});

/** Schema for updating an existing product (PUT /api/products/[id]) */
export const updateProductSchema = productBaseSchema
    .extend({
        id: z.string(),
        expectedAggregateRevision: z.number().int().min(1),
        acknowledgedSkuImageRemovalIds: z.array(productMediaAssociationIdSchema)
            .max(MAX_PRODUCT_MEDIA_ASSOCIATIONS)
            .refine((ids) => new Set(ids).size === ids.length, {
                message: "Each acknowledged product media association must be unique.",
            })
            .optional(),
        optionMatrix: productOptionMatrixBodySchema.optional()
            .describe("The complete option matrix, saved in the same write as the product. Omit to keep the options and SKUs."),
        defaultSku: defaultSkuUpdateSchema.optional()
            .describe("Edits to the hidden SKU of a product without options, saved in the same write. Not allowed with optionMatrix."),
        pageTemplate: templateAssignmentSchema.optional()
            .describe("A product page template id from the theme, or null for the theme's default. Omit to keep."),
        emiEligible: z.boolean().optional()
            .describe("Shows the store's EMI line on the product page. Omit to keep."),
        contentBlocks: productContentBlockInputListSchema.optional()
            .describe("Every editable content block, in page order within each placement, as dashboard.products.update_section takes them. Omit to keep."),
        bundles: productBundleTierInputListSchema.optional()
            .describe("Every quantity-bundle tier in display order; an empty list removes them. Omit to keep."),
        skuCosts: z.array(skuCostChangeSchema).max(MAX_PRODUCT_OPTION_COMBINATIONS).optional()
            .describe("Changed costs per item. A new optionMatrix row is named by its draft id. Each names the cost it replaces; omit to keep."),
    })
    .superRefine(requireCanonicalProductHandle)
    .superRefine(requireSellablePrice)
    .superRefine(addGiftCardInputIssues)
    .refine((value) => !(value.optionMatrix && value.defaultSku), {
        message: "Send either optionMatrix or defaultSku, not both.",
        path: ["defaultSku"],
    });

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
