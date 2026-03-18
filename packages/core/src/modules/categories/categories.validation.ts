// src/modules/categories/categories.validation.ts
import { z } from "zod";

const imageSchema = z
    .object({
        id: z.string(),
        url: z.string(),
        filename: z.string(),
        size: z.number(),
        createdAt: z
            .date()
            .or(z.string())
            .transform((val) => (val instanceof Date ? val : new Date(val))),
    })
    .nullable();

export const createCategorySchema = z.object({
    name: z.string().min(3).max(100),
    description: z.string().nullable(),
    slug: z
        .string()
        .min(3)
        .max(100)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid slug format"),
    metaTitle: z.string().nullable(),
    metaDescription: z.string().nullable(),
    image: imageSchema,
});

export const updateCategorySchema = createCategorySchema;

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
