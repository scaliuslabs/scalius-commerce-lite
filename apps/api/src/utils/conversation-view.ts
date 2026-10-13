import type { Database } from "@scalius/database/client";
import { user } from "@scalius/database/schema";
import { eq, sql } from "drizzle-orm";
import { staffPermissionSql } from "@scalius/core/auth/rbac/helpers";
import { getBuyerThread, readConversationCartShare, type StaffConversationThread, type ThreadRow } from "@scalius/core/modules/conversations";
import { hydrateConversationProducts } from "./conversation-products";
import { projectConversationCartShare } from "./conversation-cart-share";

export async function getBuyerConversationView(db: Database, thread: ThreadRow, options: { beforeSeq?: number; afterSeq?: number } = {}) {
  const view = await hydrateConversationProducts(db, await getBuyerThread(db, thread, options));
  // Incremental polls need only newly arrived messages; sharing has its own
  // versioned endpoint and does not require repricing the whole cart each poll.
  if (options.afterSeq !== undefined) return view;
  const cartShare = await readConversationCartShare(db, thread.id);
  return { ...view, cartShare: cartShare ? await projectConversationCartShare(db, cartShare, { orderId: thread.orderId }) : null };
}

export async function presentStaffConversation(db: Database, staffUserId: string, thread: StaffConversationThread) {
  const permission = await db.select({ ordersAllowed: sql<boolean>`${staffPermissionSql(user.id, "orders.view")}` })
    .from(user).where(eq(user.id, staffUserId)).get();
  return hydrateConversationProducts(db, permission?.ordersAllowed ? thread : { ...thread, order: null, cases: [] });
}
