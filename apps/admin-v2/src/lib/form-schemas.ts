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
import { phoneNumberSchema } from "@scalius/shared/customer-utils";
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
import { translate } from "~/i18n";
import { formMessages } from "~/i18n/forms";

type FormMessage = keyof (typeof formMessages)["en"];

/** A field error in the merchant's language, resolved when validation runs. */
const says = (key: FormMessage) => ({
  error: () => translate(formMessages, key),
});

const ADDRESS_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/**
 * The web address the merchant typed. Empty means "make it from the name",
 * which the server does for a new item; `requireSavedAddress` keeps a saved
 * item's address.
 */
const addressSchema = z
  .string()
  .refine((value) => value === "" || (value.length >= 3 && value.length <= 100), says("addressLength"))
  .refine((value) => value === "" || ADDRESS_PATTERN.test(value), says("addressFormat"));

function requireSavedAddress(value: { id?: string; slug: string }, context: z.RefinementCtx): void {
  if (value.id && value.slug === "") {
    context.addIssue({ code: "custom", path: ["slug"], message: translate(formMessages, "addressLength") });
  }
}

/**
 * Until address aliases exist, a canonical address may only repeat the
 * item's own public address; the object-level check enforces that.
 */
const canonicalPathFormSchema = (kind: CanonicalResourceKind) =>
  z
    .string()
    .nullable()
    .transform((value) => normalizeCanonicalPathInput(value))
    .refine(
      (value) => value === null || isValidResourceCanonicalPath(kind, value),
      says("ownAddressOnly"),
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
  createdAt: z.coerce.date<Date>(),
  updatedAt: z.coerce.date<Date>().optional(),
});

// ═══════════════════════════════════════════════════════════════════
//  CATEGORIES
// ═══════════════════════════════════════════════════════════════════

export const categoryFormSchema = z
  .object({
    id: z.string().optional(),
    revision: z.number().int().min(1).optional(),
    status: categoryStatusSchema,
    name: z
      .string()
      .trim()
      .min(3, says("nameLength"))
      .max(100, says("nameLength")),
    description: z
      .string()
      .trim()
      .max(100_000, says("textTooLong"))
      .nullable(),
    content: z
      .string()
      .trim()
      .max(100_000, says("textTooLong"))
      .nullable()
      .default(null),
    slug: addressSchema,
    metaTitle: z
      .string()
      .trim()
      .max(70, says("searchTitleTooLong"))
      .nullable(),
    metaDescription: z
      .string()
      .trim()
      .max(200, says("searchDescriptionTooLong"))
      .nullable(),
    canonicalPath: canonicalPathFormSchema("category"),
    noIndex: z.boolean(),
    excludeFromSitemap: z.boolean(),
    image: mediaFileFormSchema.nullable(),
  })
  .superRefine((value, context) => {
    requireSavedAddress(value, context);
    if (
      value.canonicalPath !== null &&
      value.canonicalPath !== `/categories/${value.slug}`
    ) {
      context.addIssue({
        code: "custom",
        path: ["canonicalPath"],
        message: translate(formMessages, "ownAddressOnly"),
      });
    }
  });

export type CategoryFormInput = z.input<typeof categoryFormSchema>;
export type CategoryFormValues = z.output<typeof categoryFormSchema>;

// ═══════════════════════════════════════════════════════════════════
//  PAGES
// ═══════════════════════════════════════════════════════════════════

export const pageFormSchema = z
  .object({
    id: z.string().optional(),
    revision: z.number().int().min(1).optional(),
    contentType: z.enum(["page", "article"]).default("page"),
    title: z
      .string()
      .min(3, says("nameLength"))
      .max(100, says("nameLength")),
    slug: addressSchema,
    content: z
      .string()
      .min(1, says("contentRequired"))
      .max(100_000, says("textTooLong")),
    excerpt: z
      .string()
      .trim()
      .max(500, says("excerptTooLong"))
      .nullable(),
    author: z
      .string()
      .trim()
      .max(100, says("authorTooLong"))
      .nullable(),
    tags: z
      .array(
        z
          .string()
          .trim()
          .min(1, says("tagsInvalid"))
          .max(60, says("tagsInvalid")),
      )
      .max(20, says("tagsInvalid")),
    metaTitle: z
      .string()
      .trim()
      .max(70, says("searchTitleTooLong"))
      .nullable(),
    metaDescription: z
      .string()
      .trim()
      .max(200, says("searchDescriptionTooLong"))
      .nullable(),
    canonicalPath: z
      .string()
      .nullable()
      .transform((value) => normalizeCanonicalPathInput(value)),
    noIndex: z.boolean(),
    excludeFromSitemap: z.boolean(),
    publicationMode: z.enum(PAGE_PUBLICATION_MODES),
    publishedAt: z.coerce.date<Date>().nullable().optional(),
    hideHeader: z.boolean(),
    hideFooter: z.boolean(),
    hideTitle: z.boolean(),
    featuredImage: mediaFileFormSchema.nullable(),
  })
  .superRefine((value, context) => {
    requireSavedAddress(value, context);
    const resourceKind = value.contentType === "article" ? "article" : "page";
    const publicPath =
      value.contentType === "article"
        ? `/blog/${value.slug}`
        : `/${value.slug}`;
    if (value.slug !== "" && !isValidResourceCanonicalPath(resourceKind, publicPath)) {
      context.addIssue({
        code: "custom",
        path: ["slug"],
        message: translate(
          formMessages,
          value.contentType === "article" ? "addressFormat" : "addressReserved",
        ),
      });
    }
    if (value.canonicalPath !== null && value.canonicalPath !== publicPath) {
      context.addIssue({
        code: "custom",
        path: ["canonicalPath"],
        message: translate(formMessages, "ownAddressOnly"),
      });
    }
    if (
      value.contentType === "page" &&
      (value.excerpt !== null || value.author !== null || value.tags.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["contentType"],
        message: translate(formMessages, "pageHasBlogFields"),
      });
    }
    if (
      value.publicationMode === "scheduled" &&
      (!value.publishedAt || value.publishedAt.getTime() <= Date.now())
    ) {
      context.addIssue({
        code: "custom",
        path: ["publishedAt"],
        message: translate(formMessages, "futureTime"),
      });
    }
  });

export type PageFormInput = z.input<typeof pageFormSchema>;
export type PageFormValues = z.output<typeof pageFormSchema>;

// ═══════════════════════════════════════════════════════════════════
//  CUSTOMERS
// ═══════════════════════════════════════════════════════════════════

export const customerFormSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(3, says("nameLength")).max(100, says("nameLength")),
  email: z.email(says("emailInvalid")).nullable(),
  phone: phoneNumberSchema,
  address: z
    .string()
    .max(500, says("addressTooLong"))
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

export const analyticsFormSchema = z
  .object({
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
    createdAt: z.coerce.date<Date>().optional(),
    updatedAt: z.coerce.date<Date>().optional(),
  })
  .superRefine((data, context) => {
    const configError = getActiveAnalyticsConfigError(data);
    if (!configError) return;
    context.addIssue({
      code: "custom",
      path: ["config"],
      message: configError,
    });
  });

export type AnalyticsFormInput = z.input<typeof analyticsFormSchema>;
export type AnalyticsFormValues = z.output<typeof analyticsFormSchema>;

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
  type CollectionFormInput,
  type CollectionFormValues,
} from "@/components/admin/collection-form/types";

// ═══════════════════════════════════════════════════════════════════
//  ORDERS (re-export from order-form/types.ts)
// ═══════════════════════════════════════════════════════════════════

export {
  orderFormSchema,
  type OrderFormInput,
  type OrderFormValues,
} from "@/components/admin/order-form/types";

