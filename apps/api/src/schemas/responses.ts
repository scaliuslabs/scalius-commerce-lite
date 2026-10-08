// apps/api/src/schemas/responses.ts
// Shared OpenAPI response schema utilities.
// Used by all route files to define typed response schemas for createRoute().

import { z } from "@hono/zod-openapi";

// ─────────────────────────────────────────
// Envelope helpers
// ─────────────────────────────────────────

/**
 * A schema a shared package built, named as one contract component
 * (`.openapi(name)`). Where a test runner loads the shared package with a
 * second copy of zod that the OpenAPI extension never reached, the schema
 * stays unnamed: only the contract's generation reads names, never
 * validation.
 */
export function namedSharedSchema<Schema extends z.ZodType>(schema: Schema, name: string): Schema {
  return typeof (schema as { openapi?: unknown }).openapi === "function" ? schema.openapi(name) : schema;
}

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
// Keyset (cursor) pagination for large lists
// ─────────────────────────────────────────

/** How a keyset-paged list is walked, repeated on its schemas so SDK and agent docs carry it. */
const KEYSET_PAGINATION_NOTE =
  "Large lists are walked with opaque cursors: pass pageInfo.endCursor as `after` for the next page and pageInfo.startCursor as `before` for the previous one. "
  + "`page` still works for the first 1,000 rows (10,000 on a Paid deployment). `total` is exact up to that many rows and a lower bound above it (see totalIsCapped).";

/** The cursors and flags of one page of a keyset-paged list. */
export const pageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  hasPreviousPage: z.boolean(),
  startCursor: z.string().nullable().openapi({ description: "Cursor of the first row; pass as `before` for the previous page. Null for an empty page." }),
  endCursor: z.string().nullable().openapi({ description: "Cursor of the last row; pass as `after` for the next page. Null for an empty page." }),
}).openapi({ description: KEYSET_PAGINATION_NOTE });

/** Pagination counts of a keyset-paged list: `total` is capped, `offset` may be unknown. */
export const cappedPaginationSchema = paginationSchema.extend({
  total: z.number().openapi({ description: "Matching rows: exact up to the count cap (1,000; 10,000 on a Paid deployment), otherwise the cap with totalIsCapped true." }),
  totalIsCapped: z.boolean().openapi({ description: "More rows match than `total` counts (show \"1,000+\")." }),
  page: z.number().openapi({ description: "Page number of this page; 0 for a cursor page deeper than the count cap." }),
  offset: z.number().int().nullable().openapi({ description: "Zero-based index of the first row of this page; null deeper than the count cap." }),
});

/**
 * Envelope of a keyset-paged list: the items, the capped `pagination` counts
 * and the `pageInfo` cursors. Additive to `paginatedEnvelope`.
 */
export const keysetPaginatedEnvelope = (itemsKey: string, itemSchema: z.ZodTypeAny, extra: z.ZodRawShape = {}) =>
  successEnvelope(
    z.object({
      [itemsKey]: z.array(itemSchema),
      pagination: cappedPaginationSchema,
      pageInfo: pageInfoSchema,
      ...extra,
    }),
  );

/** Pagination counts of a buyer-facing listing: `total` is capped (1,000; 10,000 on a Paid deployment). */
export const listingPaginationSchema = paginationSchema.extend({
  total: z.number().openapi({ description: "Matching products: exact up to the count cap (1,000; 10,000 on a Paid deployment), otherwise the cap with totalIsCapped true." }),
  totalIsCapped: z.boolean().openapi({ description: "More products match than `total` counts (show \"1,000+\")." }),
  page: z.number().openapi({ description: "Page number; 0 for a page read with `cursor`. Numbered pages reach the first 1,000 products (10,000 on a Paid deployment): deeper ones are empty." }),
});

/** Where a listing continues: `endCursor` goes back as `cursor` (newest, price-asc and price-desc only). */
export const listingPageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable().openapi({
    description: "Pass as `cursor` for the next page of the newest, price-asc and price-desc orders; null for other orders and for an empty page.",
  }),
});

/** The `cursor` query parameter shared by every buyer-facing product listing. */
export const listingCursorQuerySchema = {
  cursor: z.string().max(1024).optional().openapi({
    description: "Continue after the last product of the previous page (its pageInfo.endCursor): newest, price-asc and price-desc only, not with `page` beyond 1. Walks a large catalogue without OFFSET; a cursor from another order is rejected with INVALID_CURSOR.",
  }),
};

/** The `after`/`before` query parameters shared by every keyset-paged list. */
export const keysetQuerySchema = {
  after: z.string().max(1024).optional().openapi({
    description: "Rows after this cursor (pageInfo.endCursor of the previous page). Not with `before` or a `page` beyond 1; a cursor from another sort or direction is rejected with INVALID_CURSOR.",
  }),
  before: z.string().max(1024).optional().openapi({
    description: "Rows before this cursor (pageInfo.startCursor of the next page). Not with `after`.",
  }),
};

// ─────────────────────────────────────────
// Error response
// ─────────────────────────────────────────

/**
 * The error envelope, one named component: every route's error responses
 * refer to it instead of repeating it (about 4,000 times in the contract).
 */
export const errorResponseSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
}).openapi("ErrorResponse");

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
