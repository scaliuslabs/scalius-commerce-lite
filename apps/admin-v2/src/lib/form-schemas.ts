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
import {
  WidgetPlacementAnchorType,
  WidgetPlacementRule,
  WidgetPlacementScope,
  WidgetPlacementSlot,
} from "@/types/api-responses";
import {
  findDuplicateWidgetPlacementIndexes,
  isWidgetCollectionSlot,
  isWidgetPlacementSlotAllowedForScope,
} from "@scalius/shared/widget-placement";

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
  image: mediaFileFormSchema.nullable(),
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
  featuredImage: mediaFileFormSchema.nullable(),
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

export const analyticsScriptTypes = [
  "google_analytics",
  "facebook_pixel",
  "cloudflare_web_analytics",
  "custom",
] as const;

export type AnalyticsScriptType = (typeof analyticsScriptTypes)[number];

export const analyticsFormSchema = z.object({
  id: z.string().optional(),
  name: z
    .string()
    .min(3, "Name must be at least 3 characters")
    .max(100, "Name must be less than 100 characters"),
  type: z.enum(analyticsScriptTypes),
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

const widgetPlacementFormSchema = z.object({
  id: z.string().optional(),
  scope: z.enum([
    WidgetPlacementScope.HOMEPAGE,
    WidgetPlacementScope.PAGE,
    WidgetPlacementScope.PRODUCT,
    WidgetPlacementScope.CATEGORY,
    WidgetPlacementScope.COLLECTION,
  ]).default(WidgetPlacementScope.HOMEPAGE),
  scopeId: z.string().optional().nullable(),
  slot: z.enum([
    WidgetPlacementSlot.TOP,
    WidgetPlacementSlot.BOTTOM,
    WidgetPlacementSlot.BEFORE_CONTENT,
    WidgetPlacementSlot.AFTER_CONTENT,
    WidgetPlacementSlot.BEFORE_COLLECTION,
    WidgetPlacementSlot.AFTER_COLLECTION,
  ]).default(WidgetPlacementSlot.TOP),
  anchorType: z.enum([
    WidgetPlacementAnchorType.COLLECTION,
    WidgetPlacementAnchorType.CONTENT,
  ]).optional().nullable(),
  anchorId: z.string().optional().nullable(),
  sortOrder: z.coerce.number().int().default(0),
  isActive: z.boolean().default(true),
}).superRefine((placement, ctx) => {
  if (!placement.isActive) return;

  if (!isWidgetPlacementSlotAllowedForScope(placement.scope, placement.slot)) {
    ctx.addIssue({
      code: "custom",
      message: "Select a valid position for this placement scope.",
      path: ["slot"],
    });
  }

  if (placement.scope !== WidgetPlacementScope.HOMEPAGE && !placement.scopeId) {
    ctx.addIssue({
      code: "custom",
      message: "Select the target record for this placement.",
      path: ["scopeId"],
    });
  }

  if (placement.scope === WidgetPlacementScope.HOMEPAGE && placement.scopeId) {
    ctx.addIssue({
      code: "custom",
      message: "Homepage placements must not include a target record.",
      path: ["scopeId"],
    });
  }

  if (
    isWidgetCollectionSlot(placement.slot) &&
    (!placement.anchorId || placement.anchorType !== WidgetPlacementAnchorType.COLLECTION)
  ) {
    ctx.addIssue({
      code: "custom",
      message: "Select the collection this placement anchors to.",
      path: ["anchorId"],
    });
  }

  if (
    !isWidgetCollectionSlot(placement.slot) &&
    (placement.anchorType != null || placement.anchorId != null)
  ) {
    ctx.addIssue({
      code: "custom",
      message: "Only collection positions can include a collection anchor.",
      path: ["anchorId"],
    });
  }
});

export const widgetFormSchema = z.object({
  name: z.string().min(3, 'Widget name must be at least 3 characters long.'),
  htmlContent: z.string(),
  cssContent: z.string().optional(),
  jsContent: z.string().optional(),
  isActive: z.boolean().default(true),
  displayTarget: z.enum(['homepage']).default('homepage'),
  placementRule: z.enum([
    WidgetPlacementRule.BEFORE_COLLECTION,
    WidgetPlacementRule.AFTER_COLLECTION,
    WidgetPlacementRule.FIXED_TOP_HOMEPAGE,
    WidgetPlacementRule.FIXED_BOTTOM_HOMEPAGE,
    WidgetPlacementRule.STANDALONE,
  ]).default(WidgetPlacementRule.STANDALONE),
  referenceCollectionId: z.string().optional().nullable(),
  sortOrder: z.coerce.number().int().default(0),
  placements: z.array(widgetPlacementFormSchema).default([]),
}).superRefine((data, ctx) => {
  const activePlacements = data.placements.filter((placement) => placement.isActive);
  for (const duplicate of findDuplicateWidgetPlacementIndexes(activePlacements)) {
    ctx.addIssue({
      code: "custom",
      message: "Duplicate placement target.",
      path: ["placements", data.placements.indexOf(activePlacements[duplicate.duplicateIndex]!)],
    });
    ctx.addIssue({
      code: "custom",
      message: "Duplicate placement target.",
      path: ["placements", data.placements.indexOf(activePlacements[duplicate.firstIndex]!)],
    });
  }
});

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
