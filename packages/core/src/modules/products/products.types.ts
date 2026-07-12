// src/modules/products/products.types.ts
// Zod schemas and TypeScript interfaces shared across product modules.
import { z } from "zod";
import type { Product, ProductVariant } from "@scalius/database/schema";
import type {
    ProductOptionDefinitionRecord,
    ProductOptionStandardMapping,
    SelectedProductOption,
} from "./products.option-model";
import type { ProductCondition } from "@scalius/shared/product-condition";
import type { ProductMediaProjection } from "./products.media";

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
    selectedOptionValueIds: z.array(z.string().trim().min(1)).max(5),
    imageId: z.string().trim().min(10).max(80)
        .regex(/^pmed_[A-Za-z0-9_-]+$/u)
        .nullable(),
    weight: z.number().min(0).nullable(),
    sku: z.string().min(3, "SKU must be at least 3 characters"),
    price: variantPriceSchema,
    stock: z.number()
        .int("Stock must be a whole number")
        .min(0, "Stock must be greater than or equal to 0"),
    trackInventory: z.boolean().optional(),
    barcode: z.string().max(50).optional().nullable(),
    barcodeType: z.enum(["ean13", "upc", "isbn", "gtin", "code128", "custom"]).optional().nullable(),
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

// ─────────────────────────────────────────
// Types
// ─────────────────────────────────────────

export interface ProductWithDetails extends Product {
    category: { name: string };
    variants: Array<ProductVariant & { selectedOptions: SelectedProductOption[] }>;
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
    mediaCount: number;
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
    imageId: string | null;
    imageMediaId: string | null;
    imageUrl: string | null;
    selectedOptions: SelectedProductOption[];
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
