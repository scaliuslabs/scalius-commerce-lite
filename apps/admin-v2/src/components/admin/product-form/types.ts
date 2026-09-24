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
import { MAX_PRODUCT_PRICE } from "@scalius/shared/product-options";
import { formatNumber, translate } from "~/i18n";
import { productMessages, type ProductMessageKey } from "~/i18n/products";

/** Validation messages are read when validation runs, in the current language. */
const msg = (key: ProductMessageKey) => ({ error: () => translate(productMessages, key) });

const canonicalPathSchema = z
  .string()
  .nullable()
  .transform((value) => normalizeCanonicalPathInput(value))
  .refine(
    (value) => value === null || isValidResourceCanonicalPath("product", value),
    msg("canonicalInvalid"),
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
  name: z.string().min(3, msg("titleMin")).max(100, msg("titleMax")),
  description: z.string().min(10, msg("descriptionMin")).nullable(),
  /** Empty until the merchant types one; a draft may be saved without it. */
  price: z.number(msg("issueNotANumber"))
    .min(0, msg("priceNegative"))
    .max(MAX_PRODUCT_PRICE, { error: () => translate(productMessages, "issueTooLarge", { max: formatNumber(MAX_PRODUCT_PRICE) }) })
    .nullable(),
  categoryId: z.string().min(1, msg("chooseCategoryError")),
  isActive: z.boolean(),
  discountType: z.enum(["percentage", "flat"]),
  discountPercentage: z.number(msg("issueNotANumber")).min(0, msg("discountNegative")).nullish(),
  discountAmount: z.number(msg("issueNotANumber")).min(0, msg("discountNegative")).nullish(),
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
    .min(3, msg("webAddressInvalid"))
    .max(100, msg("webAddressInvalid"))
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, msg("webAddressInvalid")),
  media: z.array(
    z.object({
      id: z.string(),
      mediaId: z.string(),
      kind: z.enum(["image", "video"]),
      url: z.string(),
      posterMediaId: z.string().nullable(),
      posterUrl: z.string().nullable(),
      effectiveAltText: z.string(),
      /** The file's original name, which tells photos apart when they share a description. */
      filename: z.string(),
      altText: z.string().max(500),
      caption: z.string().nullable(),
      width: z.number().nullable(),
      height: z.number().nullable(),
      durationMs: z.number().nullable(),
      isPrimary: z.boolean(),
      sortOrder: z.number().int().nonnegative(),
      status: z.enum(["ready", "trashed"]),
    }),
  ).max(250, msg("mediaLimit")),
  attributes: z
    .array(
      z.object({
        attributeId: z.string().min(1, msg("chooseAttribute")),
        value: z.string().min(1, msg("attributeNeedsValue")),
      }),
    )
    .optional(),
  additionalInfo: z
    .array(
      z.object({
        id: z.string(),
        title: z.string().min(1, msg("sectionTitleRequired")),
        content: z.string().min(10, msg("sectionContentShort")),
      }),
    )
    .optional(),
  slugEdited: z.boolean().optional(),
}).superRefine((data, ctx) => {
  // Customers can't buy a product without a price, and feeds reject it.
  if (data.isActive && (data.price ?? 0) <= 0) {
    const key = data.price === null ? "priceRequired" : "priceAboveZero";
    ctx.addIssue({ code: "custom", message: translate(productMessages, key), path: ["price"] });
  }
  if (data.discountType === "flat" && (data.discountAmount ?? 0) > (data.price ?? 0)) {
    ctx.addIssue({ code: "custom", message: translate(productMessages, "issueDiscountOverPrice"), path: ["discountAmount"] });
  }
  if (data.discountType === "percentage" && (data.discountPercentage ?? 0) > 100) {
    ctx.addIssue({
      code: "custom",
      message: translate(productMessages, "issuePercentRange"),
      path: ["discountPercentage"],
    });
  }
  const associationIds = new Set<string>();
  const mediaIds = new Set<string>();
  data.media.forEach((item, index) => {
    if (associationIds.has(item.id)) {
      ctx.addIssue({ code: "custom", path: ["media", index, "id"], message: translate(productMessages, "mediaDuplicate") });
    }
    if (mediaIds.has(item.mediaId)) {
      ctx.addIssue({ code: "custom", path: ["media", index, "mediaId"], message: translate(productMessages, "mediaDuplicate") });
    }
    associationIds.add(item.id);
    mediaIds.add(item.mediaId);
  });
  if (data.media.length > 0 && data.media.filter((item) => item.isPrimary).length !== 1) {
    ctx.addIssue({ code: "custom", path: ["media"], message: translate(productMessages, "chooseMainMedia") });
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
  filename: string;
  altText: string;
  caption: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  isPrimary: boolean;
  sortOrder: number;
  status: "ready" | "trashed";
}
