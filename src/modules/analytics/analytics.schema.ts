// src/modules/analytics/analytics.schema.ts
import { z } from "zod";

export const createAnalyticsSchema = z.object({
    name: z.string().min(3).max(100),
    type: z.enum(["google_analytics", "facebook_pixel", "custom"]),
    isActive: z.boolean().default(true),
    usePartytown: z.boolean().default(true),
    config: z.string().min(1),
    location: z.enum(["head", "body_start", "body_end"]),
});

export const updateAnalyticsSchema = z.object({
    id: z.string(),
    name: z.string().min(3).max(100),
    type: z.enum(["google_analytics", "facebook_pixel", "custom"]),
    isActive: z.boolean(),
    usePartytown: z.boolean(),
    config: z.string().min(1),
    location: z.enum(["head", "body_start", "body_end"]),
});

export const toggleAnalyticsSchema = z.object({
    isActive: z.boolean(),
});
