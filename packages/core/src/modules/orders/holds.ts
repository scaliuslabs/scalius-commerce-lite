// Order holds: an app's `ctx.orders.hold` (an event handler's reaction after
// the order committed) puts the order on hold for staff review (one hold per order and app; a retried run adds
// nothing). While any hold is open the order cannot be shipped or moved on;
// staff may still cancel it. Staff release a hold, which is kept with who
// released it and when. Holds are never placed or released by buyers, and
// nothing is cancelled automatically.

import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { orderHolds, orders } from "@scalius/database/schema";
import { sha256Hex } from "@scalius/shared/hash";
import { NotFoundError, ValidationError } from "../../errors";

export interface OrderHoldView {
  id: string;
  pluginId: string;
  appName: string;
  reason: string;
  createdAt: number;
  releasedAt: number | null;
  releasedBy: string | null;
}

const REASON_MAX = 1_200;

async function holdId(orderId: string, pluginId: string): Promise<string> {
  return `ohd_${(await sha256Hex(`order-hold\0${orderId}\0${pluginId}`)).slice(0, 32)}`;
}

/** Places the apps' holds (idempotent per order and app; a released hold is not placed again). */
export async function placeAppOrderHolds(
  db: Database,
  orderId: string,
  holds: ReadonlyArray<{ pluginId: string; appName: string; reasons: readonly string[] }>,
): Promise<void> {
  for (const hold of holds) {
    const reason = (hold.reasons.length > 0 ? hold.reasons.join("\n") : `${hold.appName} asked for a review.`).slice(0, REASON_MAX);
    await db.insert(orderHolds).values({
      id: await holdId(orderId, hold.pluginId),
      orderId,
      pluginId: hold.pluginId,
      appName: hold.appName.slice(0, 80) || hold.pluginId.slice(0, 80),
      reason,
      createdAt: sql`unixepoch()`,
    }).onConflictDoNothing({ target: orderHolds.id });
  }
}

/** Every hold of the orders, open ones first, oldest first. */
export async function listOrderHolds(db: Database, orderIds: readonly string[]): Promise<Map<string, OrderHoldView[]>> {
  const byOrder = new Map<string, OrderHoldView[]>();
  if (orderIds.length === 0) return byOrder;
  const rows = await db.select().from(orderHolds)
    .where(inArray(orderHolds.orderId, [...new Set(orderIds)].slice(0, 90)))
    .orderBy(asc(orderHolds.createdAt), asc(orderHolds.id))
    .all();
  for (const row of rows) {
    const list = byOrder.get(row.orderId) ?? [];
    list.push({
      id: row.id,
      pluginId: row.pluginId,
      appName: row.appName,
      reason: row.reason,
      createdAt: row.createdAt,
      releasedAt: row.releasedAt ?? null,
      releasedBy: row.releasedBy ?? null,
    });
    byOrder.set(row.orderId, list);
  }
  for (const list of byOrder.values()) list.sort((left, right) => Number(left.releasedAt !== null) - Number(right.releasedAt !== null));
  return byOrder;
}

/** SQL: the order has no open hold (for a claim's WHERE, so a hold placed meanwhile still wins). */
export function noOpenOrderHoldCondition(orderId: string | SQL): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM ${orderHolds} WHERE ${orderHolds.orderId} = ${orderId} AND ${orderHolds.releasedAt} IS NULL)`;
}

/** Refuses work that moves a held order on, naming the app and its reason. */
export async function assertOrderNotOnHold(db: Database, orderId: string): Promise<void> {
  const open = await db.select({ appName: orderHolds.appName, reason: orderHolds.reason }).from(orderHolds)
    .where(and(eq(orderHolds.orderId, orderId), isNull(orderHolds.releasedAt)))
    .orderBy(asc(orderHolds.createdAt))
    .limit(1)
    .get();
  if (open) {
    throw new ValidationError(`This order is on hold for review (${open.appName}: ${open.reason.split("\n")[0]}). Release the hold first.`, {
      reason: "ORDER_ON_HOLD",
    });
  }
}

/** Staff release one open hold. Releasing an already released hold changes nothing. */
export async function releaseOrderHold(
  db: Database,
  orderId: string,
  id: string,
  actorUserId: string | null,
): Promise<OrderHoldView> {
  const order = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).get();
  if (!order) throw new NotFoundError("Order not found");
  await db.update(orderHolds).set({ releasedAt: sql`unixepoch()`, releasedBy: actorUserId })
    .where(and(eq(orderHolds.id, id), eq(orderHolds.orderId, orderId), isNull(orderHolds.releasedAt)));
  const hold = (await listOrderHolds(db, [orderId])).get(orderId)?.find((candidate) => candidate.id === id);
  if (!hold) throw new NotFoundError("Hold not found");
  return hold;
}
