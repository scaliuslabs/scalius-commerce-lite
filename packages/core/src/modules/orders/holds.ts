// Order holds: an app's `ctx.orders.hold` (an event handler's reaction after
// the order committed) puts the order on hold for staff review (one hold per order and app; a retried run adds
// nothing). While any hold is open the order cannot be shipped or moved on;
// staff may still cancel it. Staff release a hold, which is kept with who
// released it and when; the app that placed a hold may release that one
// hold itself (`releaseAppOrderHold`: a company approver's yes), never
// another app's or the platform's. Holds are never placed or released by
// buyers, and nothing is cancelled automatically. The platform also holds an order, in
// the app's name, when an app records an invoice payment while gift cards or
// downloads are still owed (`buildAppPaymentReviewHoldInsert`).

import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { buildBatchGuard, isBatchGuardError, safeBatch, type Database } from "@scalius/database/client";
import { orderHolds, orderItems, orders } from "@scalius/database/schema";
import { AUTO_FULFILLMENT_TYPES } from "@scalius/shared/fulfilment";
import { sha256Hex } from "@scalius/shared/hash";
import { ConflictError, NotFoundError, ValidationError } from "../../errors";

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

/** The id of the hold an app's own `ctx.orders.hold` places: the only hold that app may release. */
export async function appOrderHoldId(orderId: string, pluginId: string): Promise<string> {
  return `ohd_${(await sha256Hex(`order-hold\0${orderId}\0${pluginId}`)).slice(0, 32)}`;
}
const holdId = appOrderHoldId;

/** Why the platform holds an order whose payment an app recorded (security audit S3). */
export const APP_PAYMENT_REVIEW_REASON =
  "This app recorded an invoice payment. Check the money arrived before the order's gift cards and downloads are handed over.";

/**
 * The platform's review hold for one payment an app recorded on an order
 * with gift cards or downloads still owed (a recorded payment moves no money,
 * so stored value waits for staff to confirm it arrived). One hold per
 * payment, written in the payment's own batch and only when `landed` holds;
 * an order with nothing automatic to hand over gets none. The app cannot
 * release it: it is not the hold its `ctx.orders.hold` placed. The statement
 * comes back wrapped: a query builder is a thenable, so a promise resolved
 * with it bare would run it on its own.
 */
export async function buildAppPaymentReviewHoldInsert(
  db: Database,
  input: { orderId: string; paymentId: string; pluginId: string; appName: string; landed: SQL },
) {
  const id = `ohd_${(await sha256Hex(`order-hold\0payment-review\0${input.orderId}\0${input.paymentId}`)).slice(0, 32)}`;
  const appName = (input.appName || input.pluginId).slice(0, 80);
  return { statement: db.insert(orderHolds).select(db.select({
    id: sql<string>`${id}`.as("id"),
    orderId: orders.id,
    pluginId: sql<string>`${input.pluginId}`.as("plugin_id"),
    appName: sql<string>`${appName}`.as("app_name"),
    reason: sql<string>`${APP_PAYMENT_REVIEW_REASON}`.as("reason"),
    createdAt: sql<number>`unixepoch()`.as("created_at"),
    releasedAt: sql<null>`NULL`.as("released_at"),
    releasedBy: sql<null>`NULL`.as("released_by"),
  }).from(orders).where(and(
    eq(orders.id, input.orderId),
    input.landed,
    sql`EXISTS (SELECT 1 FROM ${orderItems} WHERE ${orderItems.orderId} = ${input.orderId}
      AND ${inArray(orderItems.fulfillmentType, [...AUTO_FULFILLMENT_TYPES])}
      AND ${orderItems.fulfilledQuantity} < ${orderItems.quantity})`,
  ))).onConflictDoNothing({ target: orderHolds.id }) };
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
      reason: "order_on_hold",
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

const APP_RELEASE_GUARD = "order_hold_app_release_conflict";

export interface AppOrderHoldRelease {
  hold: OrderHoldView;
  /** The hold was already released (by the app or by staff): nothing changed. */
  replayed: boolean;
}

/**
 * The app releases the hold its own `ctx.orders.hold` placed on the order
 * (the only hold whose id is `appOrderHoldId(order, app)`): never another
 * app's, the platform's review of a payment the app recorded, or anything
 * staff hold. Under the order's revision: a change since `expectedVersion`
 * was read is refused (409) and nothing is released; the release advances
 * the revision in the same batch. Releasing a released hold changes nothing
 * (`replayed`), whatever the revision. No hold of the app: not found.
 */
export async function releaseAppOrderHold(
  db: Database,
  input: { orderId: string; pluginId: string; expectedVersion: number },
): Promise<AppOrderHoldRelease> {
  const id = await appOrderHoldId(input.orderId, input.pluginId);
  const [order, placed] = await Promise.all([
    db.select({ version: orders.version, deletedAt: orders.deletedAt }).from(orders).where(eq(orders.id, input.orderId)).get(),
    db.select({ pluginId: orderHolds.pluginId, releasedAt: orderHolds.releasedAt }).from(orderHolds)
      .where(and(eq(orderHolds.id, id), eq(orderHolds.orderId, input.orderId))).get(),
  ]);
  if (!order || order.deletedAt) throw new NotFoundError("Order not found");
  if (!placed || placed.pluginId !== input.pluginId) throw new NotFoundError("This app placed no hold on the order.");
  const current = async (replayed: boolean): Promise<AppOrderHoldRelease> => {
    const hold = (await listOrderHolds(db, [input.orderId])).get(input.orderId)?.find((candidate) => candidate.id === id);
    if (!hold) throw new NotFoundError("This app placed no hold on the order.");
    return { hold, replayed };
  };
  if (placed.releasedAt !== null && placed.releasedAt !== undefined) return current(true);
  if (order.version !== input.expectedVersion) throw new ConflictError("This order changed. Read it again before releasing the hold.");

  const claimedVersion = order.version + 1;
  const statements: BatchItem<"sqlite">[] = [
    db.update(orders).set({ version: claimedVersion, updatedAt: sql`unixepoch()` }).where(and(
      eq(orders.id, input.orderId),
      eq(orders.version, order.version),
      isNull(orders.deletedAt),
      sql`EXISTS (SELECT 1 FROM ${orderHolds} WHERE ${orderHolds.id} = ${id} AND ${orderHolds.releasedAt} IS NULL)`,
    )) as BatchItem<"sqlite">,
    buildBatchGuard(db, sql`EXISTS (
      SELECT 1 FROM ${orders} WHERE ${orders.id} = ${input.orderId} AND ${orders.version} = ${claimedVersion}
    )`, APP_RELEASE_GUARD),
    db.update(orderHolds).set({ releasedAt: sql`unixepoch()`, releasedBy: null })
      .where(and(eq(orderHolds.id, id), isNull(orderHolds.releasedAt))) as BatchItem<"sqlite">,
  ];
  try {
    await safeBatch(db, statements);
  } catch (error) {
    if (isBatchGuardError(error, APP_RELEASE_GUARD)) {
      const again = await db.select({ releasedAt: orderHolds.releasedAt }).from(orderHolds).where(eq(orderHolds.id, id)).get();
      if (again?.releasedAt !== null && again?.releasedAt !== undefined) return current(true);
      throw new ConflictError("This order changed. Read it again before releasing the hold.");
    }
    throw error;
  }
  return current(false);
}
