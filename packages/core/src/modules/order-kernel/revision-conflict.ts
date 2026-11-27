// The refusal of an order write whose compare-and-set lost after its read
// matched: a caller that named the revision it read (`expectedRevision`) and
// finds the order moved gets 409 `order_revision_conflict`, the same answer
// as when the read itself was stale; a caller that named none gets a plain
// 409 `conflict` (the write acted on the order as it was, and something
// raced it).

import type { Database } from "@scalius/database/client";
import { orders } from "@scalius/database/schema";
import { eq } from "drizzle-orm";
import { ConflictError, OrderRevisionConflictError } from "@scalius/core/errors";

export async function orderWriteConflict(
  db: Database,
  orderId: string,
  expectedVersion: number | undefined,
  message = "This order changed. Reload to see the latest.",
): Promise<ConflictError> {
  if (expectedVersion === undefined) return new ConflictError(message);
  const now = await db.select({ version: orders.version }).from(orders).where(eq(orders.id, orderId)).get();
  return now && now.version !== expectedVersion ? new OrderRevisionConflictError(message) : new ConflictError(message);
}
