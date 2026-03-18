// src/modules/products/products.types.ts
// Zod schemas and TypeScript interfaces shared across product modules.
import { z } from "zod";
import type { Product, ProductVariant, ProductImage } from "@scalius/database/schema";

// ─────────────────────────────────────────
// Variant Validation Schemas
// ─────────────────────────────────────────

export const createVariantSchema = z.object({
    size: z.string().nullable(),
    color: z.string().nullable(),
    weight: z.number().min(0).nullable(),
    sku: z.string().min(3, "SKU must be at least 3 characters"),
    price: z.number().min(0, "Price must be greater than or equal to 0"),
    stock: z.number().min(0, "Stock must be greater than or equal to 0"),
    barcode: z.string().max(50).optional().nullable(),
    barcodeType: z.enum(["ean13", "upc", "isbn", "gtin", "custom"]).optional().nullable(),
    discountType: z.enum(["percentage", "flat"]).optional(),
    discountPercentage: z.number().min(0).max(100).nullable().optional(),
    discountAmount: z.number().min(0).nullable().optional(),
});

export const updateVariantSchema = createVariantSchema;

const sortItemSchema = z.object({
    value: z.string(),
    sortOrder: z.number(),
});

export const updateSortOrderSchema = z.object({
    colors: z.array(sortItemSchema),
    sizes: z.array(sortItemSchema),
});

export const bulkVariantSchema = z.object({
    size: z.string().nullable(),
    color: z.string().nullable(),
    weight: z.number().min(0).nullable(),
    sku: z.string().min(3, "SKU must be at least 3 characters"),
    price: z.number().min(0, "Price must be greater than or equal to 0"),
    stock: z.number().min(0, "Stock must be greater than or equal to 0"),
    barcode: z.string().max(50).optional().nullable(),
    barcodeType: z.enum(["ean13", "upc", "isbn", "gtin", "custom"]).optional().nullable(),
    discountType: z.enum(["percentage", "flat"]),
    discountPercentage: z.number().min(0).max(100).nullable(),
    discountAmount: z.number().min(0).nullable(),
});

export const bulkCreateVariantsSchema = z.object({
    variants: z.array(bulkVariantSchema).min(1, "At least one variant is required"),
});

export const bulkDeleteVariantsSchema = z.object({
    variantIds: z.array(z.string()),
});

export const bulkUpdateVariantsSchema = z.object({
    updates: z.array(
        z.object({
            id: z.string(),
            size: z.string().nullable().optional(),
            color: z.string().nullable().optional(),
            weight: z.number().nullable().optional(),
            sku: z.string().optional(),
            price: z.number().min(0).optional(),
            stock: z.number().min(0).optional(),
            barcode: z.string().max(50).nullable().optional(),
            barcodeType: z.enum(["ean13", "upc", "isbn", "gtin", "custom"]).nullable().optional(),
        })
    ),
});

// ─────────────────────────────────────────
// Types
// ─────────────────────────────────────────

export interface ProductWithDetails extends Product {
    category: { name: string };
    variants: ProductVariant[];
    images: ProductImage[];
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
    discountPercentage: number | null;
    freeDelivery: boolean;
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
    attributeFilters?: { slug: string; value: string }[];
}
