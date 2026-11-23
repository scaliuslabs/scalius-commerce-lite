import type { Database } from "@scalius/database/client";
import { user } from "@scalius/database/schema";
import { eq, sql } from "drizzle-orm";
import { staffPermissionSql } from "@scalius/core/auth/rbac/helpers";
import type { Context } from "hono";
import {
  conversationTopicView,
  getBuyerThread,
  readConversationCartShare,
  readConversationTopics,
  type StaffConversationSummary,
  type StaffConversationThread,
  type ThreadRow,
} from "@scalius/core/modules/conversations";
import { applyTranslation, readTranslationChains, translationScope, type TranslationScope } from "@scalius/core/modules/translations";
import type { ConversationTopic } from "@scalius/shared/conversation";
import { MARKET_PRESENCE_QUERY_PARAM } from "@scalius/shared/markets";
import { getPluginInstallation } from "@scalius/core/modules/plugins";
import { parseCustomChannelId } from "@scalius/shared/plugins/providers";
import { hydrateConversationProducts } from "./conversation-products";
import { projectConversationCartShare } from "./conversation-cart-share";

/** A buyer read's language for merchant words (topics): the page's presence (`?presence=bn-bd`), else the source words. */
export function buyerTranslation(c: Context): TranslationScope | null {
  return translationScope(new URL(c.req.url).searchParams.get(MARKET_PRESENCE_QUERY_PARAM));
}

/** The merchant's topics named in the scope's language (one more statement at a presence, none at the root). */
export async function buyerConversationTopics(db: Database, scope: TranslationScope | null): Promise<ConversationTopic[]> {
  const topics = await readConversationTopics(db);
  if (!scope || topics.length === 0) return topics;
  const chains = await readTranslationChains(db, scope, "conversation_topic", topics.map((topic) => topic.key));
  return topics.map((topic) => applyTranslation(topic, chains.get(topic.key) ?? [], { label: "label" }));
}

/** Threads' topic keys as readers see them (`{ key, label }`), labelled from one read of the merchant's list. */
export async function withTopicViews<T extends { topic: string | null }>(db: Database, items: readonly T[], scope: TranslationScope | null, topics?: readonly ConversationTopic[]) {
  const list = topics ?? (items.some((item) => item.topic) ? await buyerConversationTopics(db, scope) : []);
  return items.map((item) => ({ ...item, topic: conversationTopicView(item.topic, list) }));
}

export async function getBuyerConversationView(db: Database, thread: ThreadRow, options: { beforeSeq?: number; afterSeq?: number; scope?: TranslationScope | null } = {}) {
  const [threadView] = await withTopicViews(db, [await getBuyerThread(db, thread, options)], options.scope ?? null);
  const view = await hydrateConversationProducts(db, threadView!);
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
