import { z } from "zod";
import { translate } from "~/i18n";
import { collectionFormMessages } from "~/i18n/collection-form";
import type { BuyerPriceRange } from "~/lib/format-utils";

/** Messages resolve when validation runs, so they follow the current language. */
const message = (key: keyof typeof collectionFormMessages.en) => ({
  error: () => translate(collectionFormMessages, key),
});

/** The most products or categories one collection can hold (one D1 lookup). */
export const MAX_MEMBERSHIP_IDS = 90;

export interface Category {
  id: string;
  name: string;
  status: "draft" | "published" | "internal";
}

export interface Product {
  id: string;
  name: string;
  categoryId?: string | null;
  /** What buyers pay; null when nothing is priced yet. */
  priceRange?: BuyerPriceRange | null;
  categoryName?: string | null;
  isActive?: boolean;
  primaryImage?: string | null;
  /** Optioned SKUs; 0 for a simple product. */
  variantCount?: number;
  /** Sellable units across tracked SKUs; null when stock isn't tracked. */
  available?: number | null;
}

export const collectionFormSchema = z.object({
  id: z.string().optional(),
  version: z.number().int().min(1).optional(),
  name: z.string().min(3, message("nameTooShort")).max(100, message("nameTooLong")),
  description: z.string().trim().max(100_000, message("textTooLong")).nullable().default(null),
  content: z.string().trim().max(100_000, message("textTooLong")).nullable().default(null),
  presentation: z.enum(["grid", "carousel"]),
  isActive: z.boolean(),
  // Not edited here: saved values round-trip unchanged and the API validates them.
  canonicalPath: z.string().nullable(),
  noIndex: z.boolean(),
  excludeFromSitemap: z.boolean(),
  metaTitle: z.string().trim().max(70, message("metaTitleTooLong")).nullable().default(null),
  metaDescription: z.string().trim().max(200, message("metaDescriptionTooLong")).nullable().default(null),
  config: z.object({
    source: z.enum(["manual", "dynamic"]),
    categoryIds: z.array(z.string().trim().min(1).max(180)).max(MAX_MEMBERSHIP_IDS),
    productIds: z.array(z.string().trim().min(1).max(180)).max(MAX_MEMBERSHIP_IDS),
    featuredProductId: z.string().trim().max(180).optional(),
    showOnHomepage: z.boolean(),
    maxProducts: z
      .number(message("productsShownRange"))
      .int(message("productsShownRange"))
      .min(1, message("productsShownRange"))
      .max(24, message("productsShownRange")),
    title: z.string().trim().max(120).optional(),
    subtitle: z.string().trim().max(240).optional(),
  }),
}).superRefine((value, ctx) => {
  if (!value.isActive) return;
  if (value.config.source === "manual" && value.config.productIds.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["config", "productIds"],
      message: translate(collectionFormMessages, "needProducts"),
    });
  }
  if (value.config.source === "dynamic" && value.config.categoryIds.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["config", "categoryIds"],
      message: translate(collectionFormMessages, "needCategories"),
    });
  }
});

export type CollectionFormInput = z.input<typeof collectionFormSchema>;
export type CollectionFormValues = z.output<typeof collectionFormSchema>;

export interface CollectionFormProps {
  categories: Category[];
  products?: Product[];
  defaultValues?: Partial<CollectionFormValues>;
  isEdit?: boolean;
}
