import { z } from "zod";

export interface Category {
  id: string;
  name: string;
}

export interface Product {
  id: string;
  name: string;
  categoryId?: string | null;
  categoryName?: string;
  price?: number;
}

export const collectionTypes = [
  {
    value: "manual",
    label: "Manual (Grid)",
    description: "Grid layout with featured product (Large card + grid)",
  },
  {
    value: "dynamic",
    label: "Dynamic (Carousel)",
    description: "Horizontal scrolling product carousel",
  },
] as const;

export const collectionFormSchema = z.object({
  id: z.string().optional(),
  name: z
    .string()
    .min(3, "Collection name must be at least 3 characters")
    .max(100, "Collection name must be less than 100 characters"),
  type: z.enum(["manual", "dynamic"]),
  isActive: z.boolean(),
  config: z.object({
    categoryIds: z.array(z.string()),
    productIds: z.array(z.string()),
    featuredProductId: z.string().optional(),
    maxProducts: z.number().int().min(1).max(24),
    title: z.string().optional(),
    subtitle: z.string().optional(),
  }),
});

export type CollectionFormValues = z.infer<typeof collectionFormSchema>;

export interface CollectionFormProps {
  categories: Category[];
  products?: Product[];
  defaultValues?: Partial<CollectionFormValues>;
  isEdit?: boolean;
}
