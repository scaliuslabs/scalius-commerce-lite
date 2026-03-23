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
import { WidgetPlacementRule } from "@/types/api-responses";

// ═══════════════════════════════════════════════════════════════════
//  CATEGORIES
// ═══════════════════════════════════════════════════════════════════

export const categoryFormSchema = z.object({
  id: z.string().optional(),
  name: z
    .string()
    .min(3, "Category name must be at least 3 characters")
    .max(100, "Category name must be less than 100 characters"),
  description: z.string().nullable(),
  slug: z
    .string()
    .min(3, "Slug must be at least 3 characters")
    .max(100, "Slug must be less than 100 characters")
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid slug format"),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  image: z
    .object({
      id: z.string(),
      url: z.string(),
      filename: z.string(),
      size: z.number(),
      createdAt: z.coerce.date(),
    })
    .nullable(),
  slugEdited: z.boolean().optional(),
});

export type CategoryFormValues = z.infer<typeof categoryFormSchema>;

// ═══════════════════════════════════════════════════════════════════
//  PAGES
// ═══════════════════════════════════════════════════════════════════

export const pageFormSchema = z.object({
  id: z.string().optional(),
  title: z
    .string()
    .min(3, "Page title must be at least 3 characters")
    .max(100, "Page title must be less than 100 characters"),
  slug: z
    .string()
    .min(3, "Slug must be at least 3 characters")
    .max(100, "Slug must be less than 100 characters")
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid slug format"),
  content: z.string().min(1, "Content is required"),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  isPublished: z.boolean(),
  publishedAt: z.coerce.date().nullable().optional(),
  sortOrder: z.number(),
  hideHeader: z.boolean(),
  hideFooter: z.boolean(),
  hideTitle: z.boolean(),
  featuredImage: z
    .object({
      id: z.string(),
      url: z.string(),
      filename: z.string(),
      size: z.number(),
      createdAt: z.coerce.date(),
    })
    .nullable(),
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

export const analyticsFormSchema = z.object({
  id: z.string().optional(),
  name: z
    .string()
    .min(3, "Name must be at least 3 characters")
    .max(100, "Name must be less than 100 characters"),
  type: z.enum(["google_analytics", "facebook_pixel", "custom"]),
  isActive: z.boolean(),
  usePartytown: z.boolean(),
  config: z.string().min(1, "Configuration is required"),
  location: z.enum(["head", "body_start", "body_end"]),
  createdAt: z.coerce.date().optional(),
  updatedAt: z.coerce.date().optional(),
});

export type AnalyticsFormValues = z.infer<typeof analyticsFormSchema>;

// ═══════════════════════════════════════════════════════════════════
//  WIDGETS
// ═══════════════════════════════════════════════════════════════════

export const widgetFormSchema = z.object({
  name: z.string().min(3, 'Widget name must be at least 3 characters long.'),
  htmlContent: z.string().min(1, 'HTML content cannot be empty.'),
  cssContent: z.string().optional(),
  isActive: z.boolean().default(true),
  displayTarget: z.enum(['homepage']).default('homepage'),
  placementRule: z.enum([
    WidgetPlacementRule.BEFORE_COLLECTION,
    WidgetPlacementRule.AFTER_COLLECTION,
    WidgetPlacementRule.FIXED_TOP_HOMEPAGE,
    WidgetPlacementRule.FIXED_BOTTOM_HOMEPAGE,
    WidgetPlacementRule.STANDALONE,
  ]),
  referenceCollectionId: z.string().optional().nullable(),
  sortOrder: z.coerce.number().int().default(0),
}).refine(
  (data) => {
    if (
      (data.placementRule === WidgetPlacementRule.BEFORE_COLLECTION ||
        data.placementRule === WidgetPlacementRule.AFTER_COLLECTION) &&
      !data.referenceCollectionId
    ) {
      return false;
    }
    return true;
  },
  {
    message: 'A collection must be selected for "Before Collection" or "After Collection" placement.',
    path: ['referenceCollectionId'],
  }
);

export type WidgetFormValues = z.infer<typeof widgetFormSchema>;

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
  formSchema as amountOffProductsFormSchema,
  type FormValues as AmountOffProductsFormValues,
} from "@/components/admin/discount/amount-off-products/types";
