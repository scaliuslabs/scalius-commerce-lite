// API composition keeps catalog out of the conversations domain graph. Stored
// cards contain identity and sent labels only; all actionable facts are live.
import type { Database } from "@scalius/database/client";
import { BACKUP_MARKET_ID, marketPresences, markets, orders } from "@scalius/database/schema";
import { and, asc, eq, sql } from "drizzle-orm";
import { getPublicSkuCards, type PublicSkuCardRef } from "@scalius/core/modules/catalog";
import { servedLanguageSql } from "@scalius/core/modules/markets";
import { MarketPricesUnavailableError, startMarketPricing, type MarketPricing } from "@scalius/core/modules/price-lists";
import { NotFoundError, ValidationError } from "./api-error";
import { fromMinor } from "@scalius/shared/money";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { CONVERSATION_LIMITS, conversationProductSnapshots, type ConversationProductSnapshot, type ConversationProductCard } from "@scalius/shared/conversation";
export type { ConversationProductSnapshot, ConversationProductCard } from "@scalius/shared/conversation";
type Context = { orderId?: string | null };
const CARD_ID = /^[A-Za-z0-9_-]{1,128}$/;

async function conversationPricing(db: Database, { orderId }: Context): Promise<MarketPricing | null> {
  if (!orderId) return null;
  // The root is itself a subfolder presence (value=''), seeded by 0112.
  const row = await db.select({ presence: marketPresences.value }).from(orders)
    .innerJoin(markets, and(eq(markets.id, sql`coalesce(${orders.marketId}, ${BACKUP_MARKET_ID})`), eq(markets.status, "active")))
    .innerJoin(marketPresences, and(eq(marketPresences.marketId, markets.id), eq(marketPresences.kind, "subfolder"), servedLanguageSql()))
    .where(eq(orders.id, orderId)).orderBy(asc(marketPresences.value)).limit(1).get();
  // A retired market is not permission to silently quote the root's currency.
  if (!row) throw new NotFoundError("The order's storefront market is unavailable.");
  return startMarketPricing(db, row.presence);
}

function assertRefs(refs: readonly PublicSkuCardRef[], maximum: number): void {
  if (refs.length < 1 || refs.length > maximum || refs.some((ref) =>
    !CARD_ID.test(ref.productId) || !CARD_ID.test(ref.skuId))) {
    throw new ValidationError(`Choose between 1 and ${maximum} products with exact SKUs.`);
  }
  if (new Set(refs.map((ref) => ref.skuId)).size !== refs.length) {
    throw new ValidationError("Choose each SKU only once.");
  }
}

async function validateRefs(db: Database, refs: readonly PublicSkuCardRef[], context: Context, maximum: number): Promise<ConversationProductSnapshot[]> {
  assertRefs(refs, maximum);
  const pricing = await conversationPricing(db, context);
  const result: ConversationProductSnapshot[] = [];
  for (let offset = 0; offset < refs.length; offset += 90) {
    const chunk = refs.slice(offset, offset + 90);
    const cards = await getPublicSkuCards(db, chunk, pricing);
    if (cards.length !== chunk.length) throw new ValidationError("A selected product or SKU is no longer available in the storefront. Choose the products again.");
    result.push(...cards.map(({ productId, skuId, title, variantLabel }) => ({
      productId, skuId, title: abbreviate(title, 160), variantLabel: variantLabel === null ? null : abbreviate(variantLabel, 80),
    })));
  }
  return result;
}

/** Call only after conversation authorization, immediately before its write. */
export async function validateConversationProductRefs(db: Database, refs: readonly PublicSkuCardRef[], context: Context = {}) {
  const cards = await validateRefs(db, refs, context, 3);
  if (JSON.stringify({ v: 1, cards }).length > CONVERSATION_LIMITS.eventDataLength) throw new ValidationError("These product labels are too long to share together.");
  return cards;
}

function abbreviate(value: string, limit: number): string {
  const characters = [...value];
  return characters.length <= limit ? value : `${characters.slice(0, limit - 1).join("")}…`;
}

/** Shared-cart lines have their own quantity authority; these are only cards. */
export const validateConversationCartProductRefs = (db: Database, refs: readonly PublicSkuCardRef[], context: Context = {}) =>
  validateRefs(db, refs, context, 99);

export async function projectConversationProductCards(
  db: Database,
  snapshots: readonly ConversationProductSnapshot[],
  context: Context = {},
): Promise<ConversationProductCard[]> {
  if (snapshots.length > CONVERSATION_LIMITS.pageSize * 3) throw new ValidationError("Too many conversation product cards.");
  if (snapshots.length === 0) return [];
  const unavailable = (snapshot: ConversationProductSnapshot): ConversationProductCard => ({
    productId: snapshot.productId, skuId: snapshot.skuId, title: snapshot.title, variantLabel: snapshot.variantLabel,
    status: "unavailable", price: null, imageUrl: null, pdpUrl: null,
  });
  const live = new Map<string, ConversationProductCard>();
  try {
    const pricing = await conversationPricing(db, context);
    const unique = [...new Map(snapshots.map((ref) => [`${ref.productId}\0${ref.skuId}`, ref])).values()];
    for (let offset = 0; offset < unique.length; offset += 90) {
      for (const card of await getPublicSkuCards(db, unique.slice(offset, offset + 90), pricing)) {
        live.set(`${card.productId}\0${card.skuId}`, {
          productId: card.productId, skuId: card.skuId, title: card.title, variantLabel: card.variantLabel,
          status: card.availableForSale ? "available" : "sold_out",
          price: { amount: fromMinor(card.priceMinor, getDecimalPlaces(card.currencyCode)), currency: card.currencyCode },
          imageUrl: card.imageUrl, pdpUrl: card.pdpUrl,
        });
      }
    }
  } catch (error) {
    // Missing market/rate disables only product actions, not support history.
    if (!(error instanceof NotFoundError || error instanceof MarketPricesUnavailableError)) throw error;
  }
  return snapshots.map((snapshot) => live.get(`${snapshot.productId}\0${snapshot.skuId}`) ?? unavailable(snapshot));
}

export async function hydrateConversationProducts<T extends {
  orderId: string | null;
  messages: Array<{ eventKind: string | null; eventData: Record<string, unknown> | null }>;
}>(db: Database, thread: T): Promise<T> {
  const perMessage = thread.messages.map((message) => message.eventKind === "product_reply" ? conversationProductSnapshots(message.eventData) : []);
  const cards = await projectConversationProductCards(db, perMessage.flat(), { orderId: thread.orderId });
  let offset = 0;
  return { ...thread, messages: thread.messages.map((message, index) => {
    const count = perMessage[index]!.length;
    const products = cards.slice(offset, offset += count);
    return count ? { ...message, products } : message;
  }) };
}
