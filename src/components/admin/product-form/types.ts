// src/components/admin/product-form/types.ts
import { z } from "zod";

export interface Category {
  id: string;
  name: string;
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
    .max(100, "Discount must be less than or equal to 100")
    .nullish(),
  discountAmount: z
    .number()
    .min(0, "Discount amount must be greater than or equal to 0")
    .nullish(),
  freeDelivery: z.boolean(),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  slug: z
    .string()
    .min(3, "Slug must be at least 3 characters")
    .max(100, "Slug must be less than 100 characters")
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid slug format"),
  images: z.array(
    z.object({
      id: z.string(),
      url: z.string(),
      filename: z.string(),
      size: z.number(),
      createdAt: z.date(),
    }),
  ),
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
});

export type ProductFormValues = z.infer<typeof productFormSchema>;

export interface ProductImage {
  id: string;
  url: string;
  filename: string;
  size: number;
  createdAt: Date;
}
