// A buyer's view of one claim: the claim facts and its thread, for the guest
// receipt (which has no inbox) and the account. Access derives from the
// claim's order exactly like the thread's own access rule (404 otherwise).

import type { Database } from "@scalius/database/client";
import { orderItems, orders, warrantyClaims } from "@scalius/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { NotFoundError } from "../../errors";
import { resolveBuyerThread, type ConversationActor, type ThreadRow } from "../conversations";
import type { WarrantyClaimResolution, WarrantyClaimStatus } from "./browser";

export interface BuyerClaimThread {
  claim: {
    id: string;
    warrantyId: string;
    orderId: string;
    orderItemId: string;
    productName: string | null;
    variantLabel: string | null;
    status: WarrantyClaimStatus;
    resolution: WarrantyClaimResolution | null;
    createdAt: number;
    closedAt: number | null;
  };
  thread: ThreadRow;
}

export async function readBuyerClaimThread(
  db: Database,
  actor: ConversationActor,
  claimId: string,
): Promise<BuyerClaimThread> {
  if (actor.kind === "staff") throw new NotFoundError("Claim not found");
  const row = await db
    .select({
      id: warrantyClaims.id,
      warrantyId: warrantyClaims.warrantyId,
      orderId: warrantyClaims.orderId,
      orderItemId: warrantyClaims.orderItemId,
      conversationId: warrantyClaims.conversationId,
      status: warrantyClaims.status,
      resolution: warrantyClaims.resolution,
      createdAt: warrantyClaims.createdAt,
      closedAt: warrantyClaims.closedAt,
      productName: orderItems.productName,
      variantLabel: orderItems.variantLabel,
    })
    .from(warrantyClaims)
    .innerJoin(orders, and(eq(orders.id, warrantyClaims.orderId), isNull(orders.deletedAt)))
    .innerJoin(orderItems, eq(orderItems.id, warrantyClaims.orderItemId))
    .where(eq(warrantyClaims.id, claimId))
    .get();
  if (!row) throw new NotFoundError("Claim not found");
  if (actor.kind === "guest_receipt" && actor.orderId !== row.orderId) throw new NotFoundError("Claim not found");
  const thread = await resolveBuyerThread(db, actor, row.conversationId).catch(() => {
    throw new NotFoundError("Claim not found");
  });
  const { conversationId: _conversationId, ...claim } = row;
  return {
    claim: {
      ...claim,
      productName: claim.productName ?? null,
      variantLabel: claim.variantLabel ?? null,
      resolution: claim.resolution ?? null,
      closedAt: claim.closedAt ?? null,
    },
    thread,
  };
}
