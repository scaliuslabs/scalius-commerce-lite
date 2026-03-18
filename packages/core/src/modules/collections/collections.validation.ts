// src/modules/collections/collections.validation.ts
import { z } from "zod";

const collectionConfigSchema = z.object({
    categoryIds: z.array(z.string()).optional().default([]),
    productIds: z.array(z.string()).optional().default([]),
    featuredProductId: z.string().optional(),
    maxProducts: z.number().int().min(1).max(24).optional().default(8),
    title: z.string().optional(),
    subtitle: z.string().optional(),
});

export const createCollectionSchema = z.object({
    name: z.string().min(3).max(100),
    type: z.enum(["manual", "dynamic"]),
    isActive: z.boolean(),
    config: collectionConfigSchema,
});

export const updateCollectionSchema = z.object({
    name: z.string().min(3).max(100).optional(),
    type: z.enum(["manual", "dynamic"]).optional(),
    isActive: z.boolean().optional(),
    config: collectionConfigSchema.optional(),
});

export type CreateCollectionInput = z.infer<typeof createCollectionSchema>;
export type UpdateCollectionInput = z.infer<typeof updateCollectionSchema>;
