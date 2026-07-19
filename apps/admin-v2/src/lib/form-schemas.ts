/**
 * Centralized Zod form schemas for all entity CRUD forms.
 *
 * Schemas that were previously defined inline in form components are extracted
 * here for reuse (e.g., server-side validation, testing). Schemas that already
 * lived in dedicated `types.ts` files are re-exported for a single import path.
 *
 * Domain-specific helper schemas (discount shared-validation, etc.) remain in
 * their original locations and are re-exported here.
 */
import { z } from "zod";
import { getActiveAnalyticsConfigError } from "@scalius/core/modules/analytics/analytics.validation";
import { categoryStatusSchema } from "@scalius/shared/category-publication";
import { PAGE_PUBLICATION_MODES } from "@/lib/page-publication";
import {
  analyticsScriptTypes,
  type AnalyticsScriptType,
} from "@/lib/analytics-script-types";
import {
  isValidResourceCanonicalPath,
  normalizeCanonicalPathInput,
  type CanonicalResourceKind,
} from "@scalius/shared/seo-canonical";

const canonicalPathFormSchema = (
  kind: CanonicalResourceKind,
  example: string,
) =>
  z
    .string()
    .nullable()
    .transform((value) => normalizeCanonicalPathInput(value))
    .refine(
      (value) => value === null || isValidResourceCanonicalPath(kind, value),
      {
        message: `Use a reachable same-store route such as ${example}.`,
      },
    );

const mediaFileFormSchema = z.object({
  id: z.string(),
  url: z.string(),
  filename: z.string(),
  size: z.number(),
  mimeType: z.string().optional(),
  altText: z.string().nullable().optional(),
  width: z.number().nullable().optional(),
  height: z.number().nullable().optional(),
  folderId: z.string().nullable().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date().optional(),
});

// ═══════════════════════════════════════════════════════════════════
//  CATEGORIES
// ═══════════════════════════════════════════════════════════════════

export const categoryFormSchema = z.object({
  id: z.string().optional(),
  revision: z.number().int().min(1).optional(),
  status: categoryStatusSchema,
  name: z
    .string()
    .trim()
    .min(3, "Category name must be at least 3 characters")
    .max(100, "Category name must be less than 100 characters"),
  description: z.string().trim().max(100_000, "Description is too long").nullable(),
  slug: z
    .string()
    .min(3, "Slug must be at least 3 characters")
    .max(100, "Slug must be less than 100 characters")
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid slug format"),
  metaTitle: z.string().trim().max(70, "Meta title must be 70 characters or fewer").nullable(),
  metaDescription: z.string().trim().max(200, "Meta description must be 200 characters or fewer").nullable(),
  canonicalPath: canonicalPathFormSchema(
    "category",
    "/categories/summer-shoes",
  ),
  noIndex: z.boolean(),
  excludeFromSitemap: z.boolean(),
  image: mediaFileFormSchema.nullable(),
  slugEdited: z.boolean().optional(),
}).superRefine((value, context) => {
  if (
    value.canonicalPath !== null &&
    value.canonicalPath !== `/categories/${value.slug}`
  ) {
    context.addIssue({
      code: "custom",
      path: ["canonicalPath"],
      message: "Use this category's current URL until URL aliases are supported.",
    });
  }
});

export type CategoryFormValues = z.infer<typeof categoryFormSchema>;

// ═══════════════════════════════════════════════════════════════════
//  PAGES
// ═══════════════════════════════════════════════════════════════════

export const pageFormSchema = z.object({
  id: z.string().optional(),
  revision: z.number().int().min(1).optional(),
  title: z
    .string()
    .min(3, "Page title must be at least 3 characters")
    .max(100, "Page title must be less than 100 characters"),
  slug: z
    .string()
    .min(3, "Slug must be at least 3 characters")
    .max(100, "Slug must be less than 100 characters")
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid slug format")
    .refine((slug) => isValidResourceCanonicalPath("page", `/${slug}`), {
      message: "This URL is reserved by the storefront. Choose another slug.",
    }),
  content: z.string().min(1, "Content is required").max(100_000, "Content is too long"),
  metaTitle: z.string().trim().max(70, "Meta title must be 70 characters or fewer").nullable(),
  metaDescription: z.string().trim().max(200, "Meta description must be 200 characters or fewer").nullable(),
  canonicalPath: canonicalPathFormSchema("page", "/returns"),
  noIndex: z.boolean(),
  excludeFromSitemap: z.boolean(),
  publicationMode: z.enum(PAGE_PUBLICATION_MODES),
  publishedAt: z.coerce.date().nullable().optional(),
  hideHeader: z.boolean(),
  hideFooter: z.boolean(),
  hideTitle: z.boolean(),
  featuredImage: mediaFileFormSchema.nullable(),
}).superRefine((value, context) => {
  if (
    value.publicationMode === "scheduled" &&
    (!value.publishedAt || value.publishedAt.getTime() <= Date.now())
  ) {
    context.addIssue({
      code: "custom",
      path: ["publishedAt"],
      message: "Choose a future publication time.",
    });
  }
});

export type PageFormValues = z.infer<typeof pageFormSchema>;

// ═══════════════════════════════════════════════════════════════════
//  CUSTOMERS
// ═══════════════════════════════════════════════════════════════════

export const customerFormSchema = z.object({
  id: z.string().optional(),
  name: z
    .string()
    .min(3, "Name must be at least 3 characters")
    .max(100, "Name must be less than 100 characters"),
  email: z.email().nullable(),
  phone: z
    .string()
    .min(7, "Phone number too short")
    .max(16, "Phone number too long"),
  address: z
    .string()
    .max(500, "Address must be less than 500 characters")
    .nullable(),
  city: z.string().nullable(),
  zone: z.string().nullable(),
  area: z.string().nullable(),
  cityName: z.string().optional(),
  zoneName: z.string().optional(),
  areaName: z.string().optional(),
});

export type CustomerFormValues = z.infer<typeof customerFormSchema>;

// ═══════════════════════════════════════════════════════════════════
//  ANALYTICS
// ═══════════════════════════════════════════════════════════════════

export { analyticsScriptTypes, type AnalyticsScriptType };

export const analyticsFormSchema = z.object({
  id: z.string().optional(),
  expectedRevision: z.number().int().min(1).optional(),
  name: z
    .string()
    .min(3, "Name must be at least 3 characters")
    .max(100, "Name must be less than 100 characters"),
  type: z.enum(analyticsScriptTypes),
  isActive: z.boolean(),
  usePartytown: z.boolean(),
  allowDuplicateProvider: z.boolean().default(false),
  config: z.string().min(1, "Configuration is required"),
  location: z.enum(["head", "body_start", "body_end"]),
  createdAt: z.coerce.date().optional(),
  updatedAt: z.coerce.date().optional(),
}).superRefine((data, context) => {
  const configError = getActiveAnalyticsConfigError(data);
  if (!configError) return;
  context.addIssue({
    code: "custom",
    path: ["config"],
    message: configError,
  });
});

export type AnalyticsFormValues = z.infer<typeof analyticsFormSchema>;

// ═══════════════════════════════════════════════════════════════════
//  PRODUCTS (re-export from product-form/types.ts)
// ═══════════════════════════════════════════════════════════════════

export {
  productFormSchema,
  type ProductFormValues,
} from "@/components/admin/product-form/types";

// ═══════════════════════════════════════════════════════════════════
//  COLLECTIONS (re-export from collection-form/types.ts)
// ═══════════════════════════════════════════════════════════════════

export {
  collectionFormSchema,
  type CollectionFormValues,
} from "@/components/admin/collection-form/types";

// ═══════════════════════════════════════════════════════════════════
//  ORDERS (re-export from order-form/types.ts)
// ═══════════════════════════════════════════════════════════════════

export {
  orderFormSchema,
  type OrderFormValues,
} from "@/components/admin/order-form/types";

// ═══════════════════════════════════════════════════════════════════
//  DISCOUNTS (re-export shared validation + per-type schemas)
// ═══════════════════════════════════════════════════════════════════

export {
  discountCodeSchema,
  sharedDiscountFields,
  refineEndDateAfterStart,
} from "@/components/admin/discount/shared-validation";

export {
  discountEditorSchema,
  type DiscountEditorValues,
} from "@/components/admin/discount/discount-editor-model";
