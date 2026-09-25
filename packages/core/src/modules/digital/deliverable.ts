import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/**
 * Cart-validation readiness column for a digital variant: 1 when the variant
 * has a ready file asset or a key pool with available keys, else 0
 * (design §3.1). It is a correlated expression inside the existing variant
 * read, so it adds no round trip.
 * Stub until B3 fills it: always 0, so digital lines keep failing closed with
 * FULFILMENT_UNAVAILABLE.
 */
export function digitalDeliverableSql(_variantId: SQLWrapper): SQL {
  return sql`0`;
}
