// src/modules/attributes/attributes.validation.ts
// Zod schemas for attribute CRUD operations.

import { z } from "zod";

const existingAttributeValueSchema = z.string().refine(
    (value) => value.trim().length > 0 && value.trim().length <= 100,
    "Value must be between 1 and 100 characters",
);

const attributeValueSchema = z
    .string()
    .trim()
    .min(1, "Value is required")
    .max(100, "Value must be at most 100 characters long");

const attributeNameSchema = z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters long")
    .max(100, "Name must be at most 100 characters long");

const attributeOptionsSchema = z
    .array(z.string().trim().min(1, "Option values cannot be empty").max(100, "Option values must be at most 100 characters long"))
    .max(500, "Too many options")
    .transform((options) => {
        const seen = new Set<string>();
        return options.filter((option) => {
            const key = option.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    });

export const createAttributeSchema = z.object({
    name: attributeNameSchema,
    slug: z
        .string()
        .trim()
        .min(2, "Slug must be at least 2 characters long")
        .max(100, "Slug must be at most 100 characters long")
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid slug format"),
    filterable: z.boolean().default(true),
    options: attributeOptionsSchema.optional()
});

export const updateAttributeSchema = z.object({
    name: attributeNameSchema.optional(),
    slug: z
        .string()
        .trim()
        .min(2, "Slug must be at least 2 characters long")
        .max(100, "Slug must be at most 100 characters long")
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid slug format")
        .optional(),
    filterable: z.boolean().optional(),
    options: attributeOptionsSchema.optional().nullable()
});

export const bulkActionSchema = z.object({
    ids: z.array(z.string().trim().min(1)).min(1, "No IDs provided").max(90, "Select at most 90 attributes"),
    permanent: z.boolean().default(false)
});

export const addValueSchema = z.object({
    value: attributeValueSchema,
});

export const updateValueSchema = z.object({
    oldValue: existingAttributeValueSchema,
    newValue: attributeValueSchema,
});

export const deleteValueSchema = z.object({
    value: existingAttributeValueSchema
});

export type CreateAttributeInput = z.infer<typeof createAttributeSchema>;
export type UpdateAttributeInput = z.infer<typeof updateAttributeSchema>;
