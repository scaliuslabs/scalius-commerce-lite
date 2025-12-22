// src/components/admin/ProductForm/variants/types.ts

import { z } from "zod";

// --- Core Types ---

export interface ProductVariant {
  id: string;
  size: string | null;
  color: string | null;
  weight: number | null;
  sku: string;
  price: number;
  stock: number;
  discountType: "percentage" | "flat";
  discountPercentage: number | null;
  discountAmount: number | null;
  colorSortOrder?: number;
  sizeSortOrder?: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

// --- Validation Schemas ---

export const variantFormSchema = z.object({
  id: z.string().optional(),
  size: z.string().max(50, "Size must be 50 characters or less.").nullable(),
  color: z.string().max(50, "Color must be 50 characters or less.").nullable(),
  weight: z.coerce
    .number({ invalid_type_error: "Must be a number" })
    .min(0, "Weight cannot be negative.")
    .nullable(),
  sku: z.string().min(1, "SKU is required."),
  price: z.coerce
    .number({ invalid_type_error: "Price is required." })
    .min(0, "Price cannot be negative."),
  stock: z.coerce
    .number({ invalid_type_error: "Stock is required." })
    .int("Stock must be a whole number.")
    .min(0, "Stock cannot be negative."),
  discountType: z.enum(["percentage", "flat"]),
  discountPercentage: z.coerce
    .number({ invalid_type_error: "Must be a number" })
    .min(0, "Discount cannot be negative.")
    .max(100, "Discount cannot exceed 100%.")
    .nullable(),
  discountAmount: z.coerce
    .number({ invalid_type_error: "Must be a number" })
    .min(0, "Discount cannot be negative.")
    .nullable(),
});

export type VariantFormValues = z.infer<typeof variantFormSchema>;

// --- Bulk Generation Types ---

export interface BulkVariantOptions {
  sizes: string[];
  colors: string[];
  basePrice: number;
  baseStock: number;
  baseWeight: number | null;
  skuTemplate: string;
  discountType: "percentage" | "flat";
  discountValue: number | null;
}

export interface BulkGeneratedVariant {
  size: string | null;
  color: string | null;
  sku: string;
  price: number;
  stock: number;
  weight: number | null;
  discountType: "percentage" | "flat";
  discountPercentage: number | null;
  discountAmount: number | null;
}

// --- Template Types ---

export interface VariantTemplate {
  id: string;
  name: string;
  description?: string;
  size: string | null;
  color: string | null;
  weight: number | null;
  price: number;
  stock: number;
  discountType: "percentage" | "flat";
  discountPercentage: number | null;
  discountAmount: number | null;
  createdAt: Date;
}

// --- CSV Import/Export Types ---

export interface CsvVariantRow {
  sku: string;
  size?: string;
  color?: string;
  weight?: number;
  price: number;
  stock: number;
  discountType?: "percentage" | "flat";
  discountValue?: number;
}

export interface CsvImportResult {
  success: boolean;
  imported: number;
  failed: number;
  errors: Array<{
    row: number;
    error: string;
    data?: CsvVariantRow;
  }>;
}

// --- SKU Template Types ---

export interface SkuTemplate {
  template: string; // e.g., "{SLUG}-{SIZE}-{COLOR}"
  variables: SkuVariable[];
}

export interface SkuVariable {
  name: string;
  placeholder: string;
  example: string;
}

export const SKU_VARIABLES: SkuVariable[] = [
  { name: "SLUG", placeholder: "{SLUG}", example: "product-name" },
  { name: "SIZE", placeholder: "{SIZE}", example: "XL" },
  { name: "COLOR", placeholder: "{COLOR}", example: "RED" },
  { name: "RANDOM", placeholder: "{RANDOM}", example: "A7F9" },
  { name: "INDEX", placeholder: "{INDEX}", example: "001" },
];

// --- Filter & Sort Types ---

export type SortField = "sku" | "price" | "stock" | "size" | "color" | "createdAt" | "updatedAt";
export type SortOrder = "asc" | "desc";

export interface VariantFilters {
  searchTerm: string;
  minPrice?: number;
  maxPrice?: number;
  minStock?: number;
  maxStock?: number;
  sizes: string[];
  colors: string[];
}

export interface VariantSort {
  field: SortField;
  order: SortOrder;
}
