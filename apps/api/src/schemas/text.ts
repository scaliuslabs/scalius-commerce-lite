import { z } from "@hono/zod-openapi";

/** Characters as people and JSON Schema's `maxLength` count them: Unicode code points, so an emoji is one, not two UTF-16 units. */
export function characterCount(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

/**
 * Text of at most `max` characters, the limit its domain check enforces
 * (reviews, conversations, warranties count code points after their own
 * normalization). The contract carries the same `maxLength`, so an app's
 * test against the sealed contract refuses exactly what production refuses;
 * never declare a looser transport bound (`max * 2`) beside a stricter
 * domain one.
 */
export function characterText(max: number) {
  return z.string()
    .refine((value) => characterCount(value) <= max, { message: `At most ${max} characters.` })
    .openapi({ maxLength: max });
}
