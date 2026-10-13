// Cart consent stores only identities, quantities and server-resolved labels.
// Live product actions/prices are projected at the HTTP edge after authorization.
import type { Database } from "@scalius/database/client";
import { normalizeCartShareLines, type CartShareLine, type ConversationCartShare } from "@scalius/core/modules/conversations";
import { projectConversationProductCards, validateConversationCartProductRefs } from "./conversation-products";

type Context = { orderId?: string | null };

export async function prepareConversationCartLines(db: Database, input: readonly CartShareLine[], context: Context = {}): Promise<CartShareLine[]> {
  const lines = normalizeCartShareLines(input);
  if (lines.length === 0) return [];
  const snapshots = new Map((await validateConversationCartProductRefs(db, lines, context)).map((card) => [card.skuId, card]));
  return lines.map((line) => ({ ...line, ...snapshots.get(line.skuId)! }));
}

export async function projectConversationCartShare(db: Database, share: ConversationCartShare, context: Context = {}) {
  const products = await projectConversationProductCards(db, share.lines.map((line) => ({
    productId: line.productId,
    skuId: line.skuId,
    title: line.title ?? "",
    variantLabel: line.variantLabel ?? null,
  })), context);
  return {
    ...share,
    lines: share.lines.map(({ productId, skuId, quantity }) => ({ productId, skuId, quantity })),
    products,
  };
}
