// Text a buyer wrote (an order note, a message, a review, a line input), as
// route and representation schemas mark it: the merchant's agents receive
// such a value labelled untrusted (apps/api/src/agent-access/mcp/untrusted.ts),
// so a note that reads like an instruction stays data. Protected contact
// fields (`x-scalius-protected`) and buyer answers to apps
// (`x-scalius-app-owned`) are buyer-written too and are labelled the same
// way without this mark.
//
// Kept free of `@hono/zod-openapi`: representation schemas use plain zod,
// whose `.meta()` the OpenAPI generator reads.

import type { z } from "zod";

/** The OpenAPI/JSON Schema keyword: `"x-scalius-buyer-text": true`. */
export const BUYER_TEXT_KEYWORD = "x-scalius-buyer-text";

/** Marks a field as text a buyer wrote. */
export function buyerText<T extends z.ZodType>(schema: T): T {
  const extended = schema as unknown as { openapi?: (metadata: Record<string, unknown>) => T };
  if (typeof extended.openapi === "function") return extended.openapi({ [BUYER_TEXT_KEYWORD]: true });
  return schema.meta({ ...((schema.meta() ?? {}) as Record<string, unknown>), [BUYER_TEXT_KEYWORD]: true }) as T;
}
