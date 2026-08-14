import { z } from "@hono/zod-openapi";

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
