// src/modules/products/products.types.ts
// Zod schemas and TypeScript interfaces shared across product modules.
import { z } from "zod";
import type { Product, ProductVariant, ProductImage } from "@scalius/database/schema";
import type { VariantImageMappingRecord } from "./products.variant-images";
import {
    MAX_PRODUCT_OPTION_COMBINATIONS,
    type ProductOptionSchema,
} from "@scalius/shared/product-options";
import type { ProductCondition } from "@scalius/shared/product-condition";

// ─────────────────────────────────────────
// Variant Validation Schemas
// ─────────────────────────────────────────

export const MAX_PRODUCT_PRICE = 1_000_000_000_000;

const variantPriceSchema = z
    .number()
    .min(0, "Price must be greater than or equal to 0")
    .max(MAX_PRODUCT_PRICE, `Price must be at most ${MAX_PRODUCT_PRICE}`);

export const expectedProductAggregateRevisionSchema = z
    .number()
    .int("Product revision must be a whole number")
    .min(1, "Product revision must be at least 1");

const variantMutationSchema = z.object({
    size: z.string().nullable(),
    color: z.string().nullable(),
    weight: z.number().min(0).nullable(),
    sku: z.string().min(3, "SKU must be at least 3 characters"),
    price: variantPriceSchema,
    stock: z.number()
        .int("Stock must be a whole number")
        .min(0, "Stock must be greater than or equal to 0"),
    trackInventory: z.boolean().optional(),
    barcode: z.string().max(50).optional().nullable(),
    barcodeType: z.enum(["ean13", "upc", "isbn", "gtin", "custom"]).optional().nullable(),
    discountType: z.enum(["percentage", "flat"]).optional(),
    discountPercentage: z.number().min(0).max(100).nullable().optional(),
    discountAmount: z.number().min(0).nullable().optional(),
});

export const createVariantSchema = variantMutationSchema.extend({
    expectedAggregateRevision: expectedProductAggregateRevisionSchema,
});

export const updateVariantSchema = variantMutationSchema.extend({
    expectedAggregateRevision: expectedProductAggregateRevisionSchema,
});

const sortItemSchema = z.object({
    value: z.string(),
    sortOrder: z.number(),
});

export const updateSortOrderSchema = z.object({
    colors: z.array(sortItemSchema),
    sizes: z.array(sortItemSchema),
    expectedAggregateRevision: expectedProductAggregateRevisionSchema,
});

export const bulkVariantSchema = z.object({
    size: z.string().nullable(),
    color: z.string().nullable(),
    weight: z.number().min(0).nullable(),
    sku: z.string().min(3, "SKU must be at least 3 characters"),
    price: variantPriceSchema,
    stock: z.number()
        .int("Stock must be a whole number")
        .min(0, "Stock must be greater than or equal to 0"),
    trackInventory: z.boolean().optional(),
    barcode: z.string().max(50).optional().nullable(),
    barcodeType: z.enum(["ean13", "upc", "isbn", "gtin", "custom"]).optional().nullable(),
    discountType: z.enum(["percentage", "flat"]),
    discountPercentage: z.number().min(0).max(100).nullable(),
    discountAmount: z.number().min(0).nullable(),
    colorSortOrder: z.number().min(0).optional(),
    sizeSortOrder: z.number().min(0).optional(),
});

export const bulkCreateVariantsSchema = z.object({
    variants: z.array(bulkVariantSchema)
        .min(1, "At least one variant is required")
        .max(
            MAX_PRODUCT_OPTION_COMBINATIONS,
            `Create at most ${MAX_PRODUCT_OPTION_COMBINATIONS} options at once`,
        ),
    expectedAggregateRevision: expectedProductAggregateRevisionSchema,
});

export const bulkDeleteVariantsSchema = z.object({
    variantIds: z.array(z.string()),
    expectedAggregateRevision: expectedProductAggregateRevisionSchema,
});

const variantEditPlanUpdateSchema = z.object({
    id: z.string().trim().min(1, "Variant ID is required"),
    size: z.string().max(50).nullable().optional(),
    color: z.string().max(50).nullable().optional(),
    weight: z.number().min(0).nullable().optional(),
    sku: z.string().trim().min(3, "SKU must be at least 3 characters").optional(),
    price: variantPriceSchema.optional(),
    stock: z.number().int("Stock must be a whole number").min(0).optional(),
    trackInventory: z.boolean().optional(),
    barcode: z.string().max(50).nullable().optional(),
    barcodeType: z.enum(["ean13", "upc", "isbn", "gtin", "custom"]).nullable().optional(),
}).refine(
    ({ id: _id, ...fields }) => Object.keys(fields).length > 0,
    { message: "Each variant update must include at least one change" },
);

export const variantEditPlanSchema = z.object({
    creates: z.array(bulkVariantSchema.extend({
        sku: z.string().trim().min(3, "SKU must be at least 3 characters"),
        stock: z.number().int("Stock must be a whole number").min(0),
    })).max(
        MAX_PRODUCT_OPTION_COMBINATIONS,
        `Create at most ${MAX_PRODUCT_OPTION_COMBINATIONS} options at once`,
    ).default([]),
    updates: z.array(variantEditPlanUpdateSchema).max(
        MAX_PRODUCT_OPTION_COMBINATIONS,
        `Update at most ${MAX_PRODUCT_OPTION_COMBINATIONS} options at once`,
    ).default([]),
    expectedAggregateRevision: expectedProductAggregateRevisionSchema,
}).superRefine((plan, ctx) => {
    if (plan.creates.length === 0 && plan.updates.length === 0) {
        ctx.addIssue({
            code: "custom",
            message: "Add at least one variant create or update",
            path: [],
        });
    }
    if (plan.creates.length + plan.updates.length > MAX_PRODUCT_OPTION_COMBINATIONS) {
        ctx.addIssue({
            code: "custom",
            message: `Change at most ${MAX_PRODUCT_OPTION_COMBINATIONS} options in one atomic edit`,
            path: [],
        });
    }
});

export type VariantEditPlan = z.infer<typeof variantEditPlanSchema>;

// ─────────────────────────────────────────
// Types
// ─────────────────────────────────────────

export interface ProductWithDetails extends Product {
    category: { name: string };
    variants: ProductVariant[];
    images: ProductImage[];
    variantImageMappings: VariantImageMappingRecord[];
    additionalInfo: Array<{ id: string; title: string; content: string; sortOrder: number }>;
    attributes: Array<{ attributeId: string; value: string }>;
}

export interface ProductListItem {
    id: string;
    name: string;
    slug: string;
    price: number;
    description: string | null;
    isActive: boolean;
    discountPercentage: number;
    discountType: string;
    discountAmount: number;
    freeDelivery: boolean;
    aggregateRevision: number;
    createdAt: Date;
    updatedAt: Date;
    category: {
        name: string;
    };
    variantCount: number;
    imageCount: number;
    primaryImage: string | null;
    sku?: string;
}

export interface StorefrontProductFilterInput {
    category?: string;
    search?: string;
    page?: number;
    limit?: number;
    sort?: "newest" | "price-asc" | "price-desc" | "name-asc" | "name-desc" | "discount";
    minPrice?: number;
    maxPrice?: number;
    freeDelivery?: "true" | "false";
    hasDiscount?: "true" | "false";
    ids?: string;
    attributeFilters?: Array<{
        id: string;
        name: string;
        slug: string;
        values: string[];
    }>;
}

export type StorefrontFeedProductFilterInput = Pick<
    StorefrontProductFilterInput,
    "category" | "search" | "page" | "limit" | "sort" | "minPrice" | "maxPrice" | "ids"
>;

export interface StorefrontFeedProductAttribute {
    name: string;
    slug: string;
    value: string;
}

export interface StorefrontFeedProductVariant {
    id: string;
    productId: string;
    size: string | null;
    color: string | null;
    weight: number | null;
    sku: string;
    price: number;
    stock: number;
    reservedStock: number;
    isDefault: boolean;
    trackInventory: boolean;
    barcode: string | null;
    barcodeType: string | null;
    discountType: string | null;
    discountPercentage: number | null;
    discountAmount: number | null;
    colorSortOrder: number | null;
    sizeSortOrder: number | null;
    deletedAt: string | null;
}

export interface StorefrontFeedProduct {
    id: string;
    name: string;
    slug: string;
    canonicalPath: string | null;
    variantOption1Label: string;
    variantOption2Label: string;
    variantOption1Schema: ProductOptionSchema;
    variantOption2Schema: ProductOptionSchema;
    description: string | null;
    price: number;
    discountType: string | null;
    discountPercentage: number | null;
    discountAmount: number | null;
    discountedPrice: number;
    freeDelivery: boolean;
    categoryId: string | null;
    excludeFromProductFeed: boolean;
    productCondition: ProductCondition | null;
    hasVariants: boolean;
    availableForSale: boolean;
    imageUrl: string | null;
    imageAlt: string | null;
    category: { id: string; name: string; slug: string } | null;
    attributes: StorefrontFeedProductAttribute[];
    variants: StorefrontFeedProductVariant[];
    updatedAt: string | null;
}
