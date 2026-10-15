import { z } from "@hono/zod-openapi";

export const relatedObjectRecordSchema = z.object({
  typeId: z.string(),
  typeHandle: z.string(),
  typeName: z.string(),
  recordId: z.string(),
  displayName: z.string(),
});
