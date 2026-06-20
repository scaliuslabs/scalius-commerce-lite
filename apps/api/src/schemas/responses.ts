// apps/api/src/schemas/responses.ts
// Shared OpenAPI response schema utilities.
// Used by all route files to define typed response schemas for createRoute().

import { z } from "@hono/zod-openapi";

// ─────────────────────────────────────────
// Envelope helpers
// ─────────────────────────────────────────

/** Wraps any data schema in the standard { success: true, data: T } envelope. */
export const successEnvelope = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({ success: z.literal(true), data: dataSchema });

/** Pagination metadata shape — shared across all paginated endpoints. */
export const paginationSchema = z.object({
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  totalPages: z.number(),
});

/**
 * Paginated response envelope.
 * Returns { success: true, data: { [itemsKey]: items[], pagination } }.
 */
export const paginatedEnvelope = (itemsKey: string, itemSchema: z.ZodTypeAny) =>
  successEnvelope(
    z.object({
      [itemsKey]: z.array(itemSchema),
      pagination: paginationSchema,
    }),
  );

// ─────────────────────────────────────────
// Error response
// ─────────────────────────────────────────

export const errorResponseSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export const serviceUnavailableResponse = {
  description: "Service unavailable",
  content: { "application/json": { schema: errorResponseSchema } },
} as const;

export const conflictResponse = {
  description: "Conflict",
  content: { "application/json": { schema: errorResponseSchema } },
} as const;

/** Reusable error response definitions for createRoute() responses block. */
export const errorResponses = {
  400: {
    description: "Validation error",
    content: { "application/json": { schema: errorResponseSchema } },
  },
  401: {
    description: "Unauthorized",
    content: { "application/json": { schema: errorResponseSchema } },
  },
  403: {
    description: "Forbidden",
    content: { "application/json": { schema: errorResponseSchema } },
  },
  404: {
    description: "Not found",
    content: { "application/json": { schema: errorResponseSchema } },
  },
  429: {
    description: "Rate limit exceeded",
    content: { "application/json": { schema: errorResponseSchema } },
  },
  500: {
    description: "Server error",
    content: { "application/json": { schema: errorResponseSchema } },
  },
} as const;

// ─────────────────────────────────────────
// Common success response shapes
// ─────────────────────────────────────────

/** { success: true, data: { message: string } } */
export const messageResponse = successEnvelope(z.object({ message: z.string() }));

/** { success: true, data: { id: string } } — for create/update returning an ID. */
export const idResponse = successEnvelope(z.object({ id: z.string() }));

/** 204 No Content (no body). */
export const noContentResponse = { description: "No content" } as const;
