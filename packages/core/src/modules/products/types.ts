// src/modules/products/products.types.ts
// Zod schemas and TypeScript interfaces shared across product modules.
import { z } from "zod";
import type { BuyerPriceRange } from "./buyer-projection";
import type { Product, ProductVariant } from "@scalius/database/schema";
import type {
    ProductOptionDefinitionRecord,
    ProductOptionStandardMapping,
    SelectedProductOption,
} from "./option-model";
import type { ProductCondition } from "@scalius/shared/product-condition";
import type { ProductMediaProjection } from "./media";
import type { BuyerAvailabilityBand } from "@scalius/shared/buyer-availability";
import {
    MAX_PRODUCT_PRICE,
    MAX_SKU_STOCK,
    MAX_SKU_WEIGHT_GRAMS,
} from "@scalius/shared/product-options";
import { editableFulfillmentKindSchema } from "./customization-schema";
import type { CustomizationView } from "./customization";

// ─────────────────────────────────────────
// Variant Validation Schemas
// ─────────────────────────────────────────

export { MAX_PRODUCT_PRICE, MAX_SKU_STOCK, MAX_SKU_WEIGHT_GRAMS };

/** A catalog price or amount in major units, inside the supported range. */
export const catalogMoneySchema = z
    .number()
    .min(0, "Enter 0 or more.")
    .max(MAX_PRODUCT_PRICE, `Enter ${MAX_PRODUCT_PRICE} or less.`);

/** An on-hand quantity. */
export const skuStockSchema = z.number()
    .int("Enter a whole number.")
    .min(0, "Enter 0 or more.")
    .max(MAX_SKU_STOCK, `Enter ${MAX_SKU_STOCK} or less.`);

/** A SKU weight in grams. */
export const skuWeightSchema = z.number()
    .min(0, "Enter 0 or more.")
    .max(MAX_SKU_WEIGHT_GRAMS, `Enter ${MAX_SKU_WEIGHT_GRAMS} or less.`)
    .describe("Weight in grams.");

const variantPriceSchema = catalogMoneySchema;

export const expectedProductAggregateRevisionSchema = z
    .number()
    .int("Product revision must be a whole number")
    .min(1, "Product revision must be at least 1");

const variantMutationSchema = z.object({
    selectedOptionValueIds: z.array(z.string().trim().min(1)).max(5),
    imageId: z.string().trim().min(10).max(80)
        .regex(/^pmed_[A-Za-z0-9_-]+$/u)
        .nullable(),
    weight: skuWeightSchema.nullable(),
    sku: z.string().min(3, "SKU must be at least 3 characters").max(100),
    price: variantPriceSchema,
    stock: skuStockSchema,
    trackInventory: z.boolean().optional(),
    barcode: z.string().max(50).optional().nullable(),
    barcodeType: z.enum(["ean13", "upc", "isbn", "gtin", "code128", "custom"]).optional().nullable(),
    discountType: z.enum(["percentage", "flat"]).optional(),
    discountPercentage: z.number().min(0).max(100).nullable().optional(),
    discountAmount: catalogMoneySchema.nullable().optional(),
    /** Omit to keep (a new SKU is physical). */
    fulfillmentKind: editableFulfillmentKindSchema.optional(),
});

export const createVariantSchema = variantMutationSchema.extend({
    expectedAggregateRevision: expectedProductAggregateRevisionSchema,
});

/** Shown whenever a quantity edit was based on stock that has since changed. */
export const STOCK_CHANGED_MESSAGE = "Stock changed since you opened this product. Reload to see the latest.";

/**
 * A quantity edit is a compare-and-set: the caller names the stockVersion it
 * read, so a sale or adjustment in between fails the save instead of being
 * overwritten. Omit both to keep the current quantity.
 */
export const expectedStockVersionSchema = z.number().int().min(0)
    .describe("The SKU stockVersion the new quantity was based on. Required with stock.");

export const updateVariantSchema = variantMutationSchema.extend({
    stock: variantMutationSchema.shape.stock.optional()
        .describe("New on-hand quantity. Omit to keep the current quantity."),
    expectedStockVersion: expectedStockVersionSchema.optional(),
    expectedAggregateRevision: expectedProductAggregateRevisionSchema,
}).refine((value) => value.stock === undefined || value.expectedStockVersion !== undefined, {
    message: "Send expectedStockVersion with stock.",
    path: ["expectedStockVersion"],
});

// ─────────────────────────────────────────
// Types
// ─────────────────────────────────────────

/** Stored catalog money columns replaced by the decimal HTTP fields. */
export type CatalogMoneyView<T> = Omit<T, "priceMinor" | "discountBps" | "discountAmountMinor"> & {
    price: number;
    discountPercentage: number;
    discountAmount: number;
};

export interface ProductWithDetails extends Omit<CatalogMoneyView<Product>, "customizationSchema"> {
    /** Buyer inputs in the decimal HTTP contract; null when none (or unreadable). */
    customizationSchema: CustomizationView | null;
    /** The stored schema does not validate: a readiness issue, checkout refuses the product. */
    customizationSchemaInvalid: boolean;
    category: { name: string };
    variants: Array<CatalogMoneyView<ProductVariant> & { selectedOptions: SelectedProductOption[] }>;
    options: ProductOptionDefinitionRecord[];
    media: ProductMediaProjection[];
    additionalInfo: Array<{ id: string; title: string; content: string; sortOrder: number }>;
    attributes: Array<{ attributeId: string; value: string }>;
}

export interface ProductListItem {
    id: string;
    name: string;
    slug: string;
    price: number;
    /** What buyers pay (the storefront's range); null when the product has no live SKU. */
    priceRange: BuyerPriceRange | null;
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
    onHand: number | null;
    hasVariantDiscount: boolean;
    hasStockHistory: boolean;
    mediaCount: number;
    primaryImage: string | null;
    sku?: string;
}

export interface StorefrontProductFilterInput {
    category?: string;
    search?: string;
    page?: number;
    limit?: number;
    /** Defaults to "relevance" when `search` is set, otherwise "newest". */
    sort?: "relevance" | "newest" | "price-asc" | "price-desc" | "name-asc" | "name-desc" | "discount";
    minPrice?: number;
    maxPrice?: number;
    freeDelivery?: "true" | "false";
    hasDiscount?: "true" | "false";
    ids?: string;
    /** Filterable attributes by slug, and product option axes as `option.<axis>` (e.g. `option.size`). */
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
> & { cursor?: string };

export interface StorefrontFeedPagination {
    limit: number;
    cursor?: string;
    hasNextPage: boolean;
}

export interface StorefrontFeedProductPage {
    products: StorefrontFeedProduct[];
    pagination: StorefrontFeedPagination;
}

export interface StorefrontFeedProductAttribute {
    name: string;
    slug: string;
    value: string;
}

export interface StorefrontFeedProductVariant {
    id: string;
    productId: string;
    optionCombinationKey?: string | null;
    imageId: string | null;
    imageMediaId: string | null;
    imageUrl: string | null;
    selectedOptions: SelectedProductOption[];
    weight: number | null;
    sku: string;
    price: number;
    stock: number;
    reservedStock: number;
    lowStockThreshold: number | null;
    availabilityBand: BuyerAvailabilityBand;
    isDefault: boolean;
    trackInventory: boolean;
    barcode: string | null;
    barcodeType: string | null;
    discountType: string | null;
    discountPercentage: number | null;
    discountAmount: number | null;
    deletedAt: string | null;
}

export interface StorefrontFeedProduct {
    id: string;
    name: string;
    slug: string;
    canonicalPath: string | null;
    options: Array<{
        id: string;
        name: string;
        position: number;
        standardMapping: ProductOptionStandardMapping;
    }>;
    description: string | null;
    price: number;
    discountType: string | null;
    discountPercentage: number | null;
    discountAmount: number | null;
    discountedPrice: number;
    freeDelivery: boolean;
    categoryId: string | null;
    excludeFromProductFeed: boolean;
    /** A buyer input is required: agent carts (variant + quantity only) can't buy it. */
    requiresCustomization: boolean;
    productCondition: ProductCondition | null;
    hasVariants: boolean;
    availableForSale: boolean;
    imageUrl: string | null;
    imageMediaId: string | null;
    imageAlt: string | null;
    category: { id: string; name: string; slug: string } | null;
    attributes: StorefrontFeedProductAttribute[];
    variants: StorefrontFeedProductVariant[];
    updatedAt: string | null;
}
