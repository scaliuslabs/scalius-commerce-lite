// apps/api/src/schemas/readiness.ts
// OpenAPI schema for the one shared readiness vocabulary
// (packages/shared/src/readiness.ts). Every admin endpoint that reports setup
// readiness embeds this exact object, so the dashboard reads `status`/`issues`
// once instead of a per-endpoint boolean.

import { z } from "@hono/zod-openapi";
import type { ReadinessStatus } from "@scalius/shared/readiness";

/** Kept literal so the generated SDK exposes the union, not a bare string. */
export const readinessStatusSchema = z.enum(["ready", "incomplete", "error"]);

// Both assignments stop compiling if this schema and the shared union drift.
const _schemaCoversSharedStatuses: z.infer<typeof readinessStatusSchema> =
  "ready" as ReadinessStatus;
const _sharedCoversSchemaStatuses: ReadinessStatus =
  "ready" as z.infer<typeof readinessStatusSchema>;
void _schemaCoversSharedStatuses;
void _sharedCoversSchemaStatuses;

export const readinessIssueSchema = z.object({
  /** Stable machine code, e.g. "missing_shipping_method". */
  code: z.string(),
  /** Merchant-facing sentence describing what is wrong. */
  message: z.string(),
  /** Optional merchant-facing sentence describing how to fix it. */
  fix: z.string().optional(),
});

export const readinessSchema = z.object({
  status: readinessStatusSchema,
  issues: z.array(readinessIssueSchema),
});
