// The order as the stable app API answers it (audit L1): the dashboard's
// order writes that are stable (status, delivered, pickup ready, a voided
// fulfilment) answer `{ order }` in the representation `orders.get` reads and
// webhooks carry, so a caller never re-reads the order for its new revision.
import { z } from "@hono/zod-openapi";
import type { Database } from "@scalius/database/client";
import { EVENT_REPRESENTATION_SCHEMAS } from "@scalius/shared/events";
import { readOrderRepresentations } from "../../events/representations";
import { namedSharedSchema } from "../../schemas/responses";
import { NotFoundError } from "../../utils/api-error";

export const OrderResource = namedSharedSchema(EVENT_REPRESENTATION_SCHEMAS.order, "OrderResource");

/** `data: { order }` beside any receipt fields of the write. */
export const orderResourceSchema = z.object({ order: OrderResource });

/** The order's sealed representation, read after a write (not found once it is gone). */
export async function readOrderResource(db: Database, orderId: string) {
  const [order] = await readOrderRepresentations(db, [orderId]);
  if (!order) throw new NotFoundError("Order not found");
  return order;
}
