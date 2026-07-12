// src/components/admin/product-form/types.ts
import { z } from "zod";
import {
  isValidResourceCanonicalPath,
  normalizeCanonicalPathInput,
} from "@scalius/shared/seo-canonical";
import {
  DEFAULT_PRODUCT_CONDITION,
  PRODUCT_CONDITION_VALUES,
  type ProductCondition,
} from "@scalius/shared/product-condition";

const canonicalPathSchema = z
  .string()
  .nullable()
  .transform((value) => normalizeCanonicalPathInput(value))
  .refine(
    (value) => value === null || isValidResourceCanonicalPath("product", value),
    {
      message: "Use a reachable product route such as /products/main-shoe.",
    },
  );

export {
  DEFAULT_PRODUCT_CONDITION,
  PRODUCT_CONDITION_VALUES,
  type ProductCondition,
};

export interface Category {
  id: string;
  name: string;
  status: "draft" | "published" | "internal";
}

export const productFormSchema = z.object({
  id: z.string().optional(),
  name: z
    .string()
    .min(3, "Product name must be at least 3 characters")
    .max(100, "Product name must be less than 100 characters"),
  description: z
    .string()
    .min(10, "Description must be at least 10 characters")
    .nullable(),
  price: z
    .number()
    .min(0, "Price must be greater than or equal to 0")
    .max(1000000000000, "Price must be less than 1000000000000"),
  categoryId: z.string().min(1, "Please select a category"),
  isActive: z.boolean(),
  discountType: z.enum(["percentage", "flat"]),
  discountPercentage: z
    .number()
    .min(0, "Discount must be greater than or equal to 0")
    .nullish(),
  discountAmount: z
    .number()
    .min(0, "Discount amount must be greater than or equal to 0")
    .nullish(),
  freeDelivery: z.boolean(),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  canonicalPath: canonicalPathSchema,
  noIndex: z.boolean(),
  excludeFromSitemap: z.boolean(),
  excludeFromProductFeed: z.boolean(),
  productCondition: z.enum(PRODUCT_CONDITION_VALUES),
  slug: z
    .string()
    .min(3, "Slug must be at least 3 characters")
    .max(100, "Slug must be less than 100 characters")
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid slug format"),
  media: z.array(
    z.object({
      id: z.string(),
      mediaId: z.string(),
      kind: z.enum(["image", "video"]),
      url: z.string(),
      posterMediaId: z.string().nullable(),
      posterUrl: z.string().nullable(),
      effectiveAltText: z.string(),
      altText: z.string().max(500),
      caption: z.string().nullable(),
      width: z.number().nullable(),
      height: z.number().nullable(),
      durationMs: z.number().nullable(),
      isPrimary: z.boolean(),
      sortOrder: z.number().int().nonnegative(),
      status: z.enum(["ready", "trashed"]),
    }),
  ).max(250, "Attach at most 250 media items to a product"),
  attributes: z
    .array(
      z.object({
        attributeId: z.string().min(1, "Please select an attribute."),
        value: z.string().min(1, "Attribute value cannot be empty."),
      }),
    )
    .optional(),
  additionalInfo: z
    .array(
      z.object({
        id: z.string(),
        title: z.string().min(1, "Title is required."),
        content: z.string().min(10, "Content is required."),
      }),
    )
    .optional(),
  slugEdited: z.boolean().optional(),
}).superRefine((data, ctx) => {
  // Only enforce max 100 for percentage discounts — flat amounts can be any value
  if (data.discountType === "percentage" && (data.discountPercentage ?? 0) > 100) {
    ctx.addIssue({
      code: "custom",
      message: "Percentage discount must be less than or equal to 100",
      path: ["discountPercentage"],
    });
  }
  const associationIds = new Set<string>();
  const mediaIds = new Set<string>();
  data.media.forEach((item, index) => {
    if (associationIds.has(item.id)) {
      ctx.addIssue({ code: "custom", path: ["media", index, "id"], message: "Each media association must be unique" });
    }
    if (mediaIds.has(item.mediaId)) {
      ctx.addIssue({ code: "custom", path: ["media", index, "mediaId"], message: "The same asset can be attached only once" });
    }
    associationIds.add(item.id);
    mediaIds.add(item.mediaId);
  });
  if (data.media.length > 0 && data.media.filter((item) => item.isPrimary).length !== 1) {
    ctx.addIssue({ code: "custom", path: ["media"], message: "Choose exactly one featured media item" });
  }
});

export type ProductFormValues = z.infer<typeof productFormSchema>;

export interface ProductMediaItem {
  id: string;
  mediaId: string;
  kind: "image" | "video";
  url: string;
  posterMediaId: string | null;
  posterUrl: string | null;
  effectiveAltText: string;
  altText: string;
  caption: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  isPrimary: boolean;
  sortOrder: number;
  status: "ready" | "trashed";
}
