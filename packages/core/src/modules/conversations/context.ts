import type { Database } from "@scalius/database/client";
import { conversations, customers, orders } from "@scalius/database/schema";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { staffPermissionSql } from "../../auth/rbac/helpers";
import { NotFoundError } from "../../errors";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { readConversationCartShare } from "./cart-share";

/** Exact account ownership only. Contact matches never disclose another buyer's history. */
export async function getConversationContext(db: Database, conversationId: string, staffUserId: string) {
  const thread = await db.select({
    id: conversations.id, orderId: conversations.orderId,
    customerId: sql<string | null>`coalesce(${conversations.customerId}, ${orders.accountOwnerCustomerId})`,
    customersAllowed: sql<boolean>`${staffPermissionSql(sql`${staffUserId}`, "customers.view")}`,
    ordersAllowed: sql<boolean>`${staffPermissionSql(sql`${staffUserId}`, "orders.view")}`,
  }).from(conversations).leftJoin(orders, eq(orders.id, conversations.orderId))
    .where(eq(conversations.id, conversationId)).get();
  if (!thread) throw new NotFoundError("Conversation not found");
  const customer = thread.customersAllowed && thread.customerId
    ? await db.select({ id: customers.id, name: customers.name, email: customers.email, phone: customers.phone })
      .from(customers).where(and(eq(customers.id, thread.customerId), isNull(customers.deletedAt))).get()
    : undefined;
  const recentOrders = thread.ordersAllowed && (thread.customerId || thread.orderId)
    ? await db.select({ id: orders.id, orderNumber: orders.orderNumber, status: orders.status,
      paymentStatus: orders.paymentStatus, totalAmountMinor: orders.totalAmountMinor, currencyCode: orders.currencyCode,
      createdAt: sql<number>`CAST(${orders.createdAt} AS INTEGER)`,
    }).from(orders).where(and(isNull(orders.deletedAt), thread.customerId
      ? eq(orders.accountOwnerCustomerId, thread.customerId) : eq(orders.id, thread.orderId!)))
      .orderBy(desc(orders.createdAt), desc(orders.id)).limit(10).all()
    : [];
  return {
    orderId: thread.orderId,
    customer: customer ?? null, customerDenied: !thread.customersAllowed,
    recentOrders: thread.ordersAllowed ? recentOrders.map((order) => ({ ...order, orderNumber: formatOrderNumber(order.orderNumber, order.id) })) : null,
    ordersDenied: !thread.ordersAllowed,
    cartShare: await readConversationCartShare(db, conversationId),
  };
}
