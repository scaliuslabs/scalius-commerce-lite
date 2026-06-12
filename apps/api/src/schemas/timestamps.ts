import { z } from "@hono/zod-openapi";

export const timestampSchema = z.union([z.string(), z.number()]);
export const nullableTimestampSchema = z.union([z.string(), z.number(), z.null()]);
export const optionalTimestampSchema = timestampSchema.optional();
export const optionalNullableTimestampSchema = nullableTimestampSchema.optional();
