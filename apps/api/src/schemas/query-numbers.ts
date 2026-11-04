import { z } from "@hono/zod-openapi";

/**
 * A whole-number query parameter written the one canonical way: digits only,
 * no sign, no leading zero, no more digits than `max` has. `z.coerce` alone
 * reads `0005000` or `5e3` as 5000, so every spelling of one number would be
 * its own cache key and its own read; a public cached read takes only the
 * canonical one.
 */
export function canonicalIntegerQuery(min: number, max: number) {
  const pattern = new RegExp(`^(?:0|[1-9]\\d{0,${String(max).length - 1}})$`);
  return z.preprocess(
    (value) => (typeof value === "string" && !pattern.test(value) ? Number.NaN : value),
    z.coerce.number().int().min(min).max(max),
  );
}
