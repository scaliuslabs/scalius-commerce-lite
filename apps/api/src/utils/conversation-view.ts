import type { Database } from "@scalius/database/client";
import { user } from "@scalius/database/schema";
import { eq, sql } from "drizzle-orm";
import { staffPermissionSql } from "@scalius/core/auth/rbac/helpers";
import { getBuyerThread, readConversationCartShare, type StaffConversationSummary, type StaffConversationThread, type ThreadRow } from "@scalius/core/modules/conversations";
import { getPluginInstallation } from "@scalius/core/modules/plugins";
import { parseCustomChannelId } from "@scalius/shared/plugins/providers";
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

/**
 * Names the threads' channels for staff: an app's own channel (`<app id>:<key>`)
 * by the name its manifest gives it (one installation read per app on the
 * page), else its key; a built-in channel is named by the dashboard (null).
 */
export async function withChannelNames<T extends Pick<StaffConversationSummary, "channel">>(db: Database, items: readonly T[]): Promise<Array<T & { channelName: string | null }>> {
  const apps = [...new Set(items.map((item) => item.channel && parseCustomChannelId(item.channel)?.appId).filter((appId): appId is string => Boolean(appId)))];
  const names = new Map<string, string>();
  for (const appId of apps) {
    const installation = await getPluginInstallation(db, appId);
    for (const provider of installation?.manifest.providers ?? []) {
      if (provider.kind !== "messaging") continue;
      for (const channel of provider.customChannels ?? []) {
        if (!names.has(`${appId}:${channel.key}`)) names.set(`${appId}:${channel.key}`, channel.name);
      }
    }
  }
  return items.map((item) => {
    const custom = item.channel ? parseCustomChannelId(item.channel) : null;
    return { ...item, channelName: custom ? names.get(item.channel!) ?? custom.key : null };
  });
}

export async function presentStaffConversation(db: Database, staffUserId: string, thread: StaffConversationThread) {
  const permission = await db.select({ ordersAllowed: sql<boolean>`${staffPermissionSql(user.id, "orders.view")}` })
    .from(user).where(eq(user.id, staffUserId)).get();
  const [named] = await withChannelNames(db, [thread]);
  return hydrateConversationProducts(db, permission?.ordersAllowed ? named! : { ...named!, order: null, cases: [] });
}
