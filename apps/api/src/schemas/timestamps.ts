import { z } from "@hono/zod-openapi";

/**
 * An instant as every stable operation carries it: ISO 8601 in UTC
 * (`2026-10-21T09:30:00.000Z`). Dashboard-only routes may still return the
 * older `timestampSchema` forms.
 */
export const isoTimestampSchema = z.string().openapi({ format: "date-time" });
export const nullableIsoTimestampSchema = isoTimestampSchema.nullable();

export const timestampSchema = z.union([z.string(), z.number()]);

const nullableTimestampOpenApi = {
  type: "string",
  nullable: true,
  anyOf: [{ type: "string" }, { type: "number" }],
} as Parameters<ReturnType<typeof z.custom<string | number | null>>["openapi"]>[1];

export const nullableTimestampSchema = z
  .custom<string | number | null>(
    (value) => value === null || typeof value === "string" || typeof value === "number",
  )
  .openapi("NullableTimestamp", nullableTimestampOpenApi);
export const optionalTimestampSchema = timestampSchema.optional();
export const optionalNullableTimestampSchema = nullableTimestampSchema.optional();
