import { z } from "zod";
import {
  isValidResourceCanonicalPath,
  normalizeCanonicalPathInput,
} from "@scalius/shared/seo-canonical";

const canonicalPathSchema = z
  .string()
  .nullable()
  .transform((value) => normalizeCanonicalPathInput(value))
  .refine(
    (value) =>
      value === null || isValidResourceCanonicalPath("collection", value),
    {
      message:
        "Use a reachable collection route such as /collections/col_1.",
    },
  );

const productIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .refine((id) => id.startsWith("prod_"), {
    message: "Select a product, not a category.",
  });

export interface Category {
  id: string;
  name: string;
  status: "draft" | "published" | "internal";
}

export interface Product {
  id: string;
  name: string;
  categoryId?: string | null;
  price?: number;
  categoryName?: string | null;
  isActive?: boolean;
}

export const collectionPresentations = [
  {
    value: "grid",
    label: "Featured grid",
    description: "Compact product grid with an optional featured product",
  },
  {
    value: "carousel",
    label: "Carousel",
    description: "Horizontal scrolling product carousel",
  },
] as const;

export const collectionFormSchema = z.object({
  id: z.string().optional(),
  version: z.number().int().min(1).optional(),
  name: z
    .string()
    .min(3, "Collection name must be at least 3 characters")
    .max(100, "Collection name must be less than 100 characters"),
  description: z.string().trim().max(100_000, "Introduction is too long").nullable().default(null),
  content: z.string().trim().max(100_000, "Content is too long").nullable().default(null),
  presentation: z.enum(["grid", "carousel"]),
  isActive: z.boolean(),
  canonicalPath: canonicalPathSchema,
  noIndex: z.boolean(),
  excludeFromSitemap: z.boolean(),
  metaTitle: z.string().trim().max(70, "Meta title must be 70 characters or fewer").nullable().default(null),
  metaDescription: z.string().trim().max(200, "Meta description must be 200 characters or fewer").nullable().default(null),
  config: z.object({
    source: z.enum(["manual", "dynamic"]),
    categoryIds: z.array(z.string().trim().min(1).max(180)).max(90),
    productIds: z.array(productIdSchema).max(90),
    featuredProductId: z.string().trim().max(180).optional(),
    showOnHomepage: z.boolean(),
    maxProducts: z.number().int().min(1).max(24),
    title: z.string().trim().max(120).optional(),
    subtitle: z.string().trim().max(240).optional(),
  }),
}).superRefine((value, ctx) => {
  if (!value.isActive) return;
  if (value.config.source === "manual" && value.config.productIds.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["config", "productIds"],
      message: "Add at least one product before publishing a manual collection.",
    });
  }
  if (value.config.source === "dynamic" && value.config.categoryIds.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["config", "categoryIds"],
      message: "Select at least one category before publishing a dynamic collection.",
    });
  }
});

export type CollectionFormValues = z.infer<typeof collectionFormSchema>;

export interface CollectionFormProps {
  categories: Category[];
  products?: Product[];
  defaultValues?: Partial<CollectionFormValues>;
  isEdit?: boolean;
}
