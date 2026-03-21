// src/modules/attributes/attributes.validation.ts
// Zod schemas for attribute CRUD operations.

import { z } from "zod";

export const createAttributeSchema = z.object({
    name: z.string().min(2, "Name must be at least 2 characters long"),
    slug: z
        .string()
        .min(2, "Slug must be at least 2 characters long")
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid slug format"),
    filterable: z.boolean().default(true),
    options: z.array(z.string()).max(500, "Too many options").optional()
});

export const updateAttributeSchema = z.object({
    name: z.string().min(2, "Name must be at least 2 characters long").optional(),
    slug: z
        .string()
        .min(2, "Slug must be at least 2 characters long")
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid slug format")
        .optional(),
    filterable: z.boolean().optional(),
    options: z.array(z.string()).max(500, "Too many options").optional().nullable()
});

export const bulkActionSchema = z.object({
    ids: z.array(z.string()).min(1, "No IDs provided"),
    permanent: z.boolean().default(false)
});

export const addValueSchema = z.object({
    value: z.string().min(1, "Value is required")
});

export const updateValueSchema = z.object({
    oldValue: z.string().min(1, "Old value is required"),
    newValue: z.string().min(1, "New value is required")
});

export const deleteValueSchema = z.object({
    value: z.string().min(1, "Value is required")
});

export type CreateAttributeInput = z.infer<typeof createAttributeSchema>;
export type UpdateAttributeInput = z.infer<typeof updateAttributeSchema>;
