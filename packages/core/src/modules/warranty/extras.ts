// Buyer and per-line warranty reads: the `extras.warranty` fact on order pages
// (receipt, account order, dashboard order), the account's Warranties list and
// its tab count. Each read is bounded by one order (the order index) or by the
// account-owner index on orders. The caller has already proven access.

import type { Database } from "@scalius/database/client";
import {
  media,
  orderItemWarranties,
  orderItems,
  orders,
  warrantyClaims,
  warrantyPolicyRevisions,
} from "@scalius/database/schema";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { publishedMediaObjectKey } from "../media/media.presentation";
import type { LineExtrasInput } from "../../utils/line-extras";
import type { LineWarrantyClaim, LineWarrantyExtra, WarrantyDurationUnit, WarrantyProvider } from "./browser";
import { nowSeconds } from "./shared";

/** The account's Warranties page shows at most this many records. */
export const BUYER_WARRANTIES_MAX = 100;

const warrantySelect = {
  warrantyId: orderItemWarranties.id,
  orderId: orderItemWarranties.orderId,
  orderItemId: orderItemWarranties.orderItemId,
  quantity: orderItemWarranties.quantity,
  startsAt: orderItemWarranties.startsAt,
  expiresAt: orderItemWarranties.expiresAt,
  replacementUntil: orderItemWarranties.replacementUntil,
  voidedAt: orderItemWarranties.voidedAt,
  policyName: warrantyPolicyRevisions.name,
  provider: warrantyPolicyRevisions.provider,
  durationValue: warrantyPolicyRevisions.durationValue,
  durationUnit: warrantyPolicyRevisions.durationUnit,
  replacementDays: warrantyPolicyRevisions.replacementDays,
  terms: warrantyPolicyRevisions.terms,
};

type WarrantyRow = {
  warrantyId: string;
  orderId: string;
  orderItemId: string;
  quantity: number;
  startsAt: number;
  expiresAt: number;
  replacementUntil: number | null;
  voidedAt: number | null;
  policyName: string;
  provider: string;
  durationValue: number;
  durationUnit: string;
  replacementDays: number | null;
  terms: string | null;
};

/** The latest claim per warranty (an open one wins over closed ones). */
async function latestClaims(db: Database, warrantyIds: readonly string[]): Promise<Map<string, LineWarrantyClaim>> {
  const claims = new Map<string, LineWarrantyClaim & { createdAt: number; open: boolean }>();
  for (let index = 0; index < warrantyIds.length; index += 90) {
    const chunk = warrantyIds.slice(index, index + 90);
    const rows = await db
      .select({
        id: warrantyClaims.id,
        warrantyId: warrantyClaims.warrantyId,
        conversationId: warrantyClaims.conversationId,
        status: warrantyClaims.status,
        resolution: warrantyClaims.resolution,
        createdAt: warrantyClaims.createdAt,
      })
      .from(warrantyClaims)
      .where(inArray(warrantyClaims.warrantyId, chunk))
      .all();
    for (const row of rows) {
      const open = row.status === "open" || row.status === "in_progress";
      const current = claims.get(row.warrantyId);
      if (current && (current.open || (!open && current.createdAt >= row.createdAt))) continue;
      claims.set(row.warrantyId, {
        id: row.id,
        conversationId: row.conversationId,
        status: row.status,
        resolution: row.resolution ?? null,
        createdAt: row.createdAt,
        open,
      });
    }
  }
  const result = new Map<string, LineWarrantyClaim>();
  for (const [warrantyId, { id, conversationId, status, resolution }] of claims) {
    result.set(warrantyId, { id, conversationId, status, resolution });
  }
  return result;
}

function presentLine(row: WarrantyRow, claim: LineWarrantyClaim | null): LineWarrantyExtra {
  return {
    warrantyId: row.warrantyId,
    policyName: row.policyName,
    provider: row.provider as WarrantyProvider,
    durationValue: row.durationValue,
    durationUnit: row.durationUnit as WarrantyDurationUnit,
    replacementDays: row.replacementDays,
    terms: row.terms,
    quantity: row.quantity,
    startsAt: row.startsAt,
    expiresAt: row.expiresAt,
    replacementUntil: row.replacementUntil,
    voided: row.voidedAt !== null,
    openClaimId: claim && (claim.status === "open" || claim.status === "in_progress") ? claim.id : null,
    claim,
  };
}

/**
 * Warranty records per order line, keyed by order item id (`extras.warranty`):
 * one per handed-over fulfilment line, oldest first, with the latest claim.
 */
export async function listLineWarranties(
  db: Database,
  input: LineExtrasInput,
): Promise<ReadonlyMap<string, readonly LineWarrantyExtra[]>> {
  const result = new Map<string, LineWarrantyExtra[]>();
  if (input.orderItemIds.length === 0) return result;
  const wanted = new Set(input.orderItemIds);
  const rows = await db
    .select(warrantySelect)
    .from(orderItemWarranties)
    .innerJoin(warrantyPolicyRevisions, eq(warrantyPolicyRevisions.id, orderItemWarranties.revisionId))
    .where(eq(orderItemWarranties.orderId, input.orderId))
    .orderBy(orderItemWarranties.startsAt, orderItemWarranties.id)
    .all() as WarrantyRow[];
  const lines = rows.filter((row) => wanted.has(row.orderItemId));
  if (lines.length === 0) return result;
  const claims = await latestClaims(db, lines.map((row) => row.warrantyId));
  for (const row of lines) {
    const list = result.get(row.orderItemId) ?? [];
    list.push(presentLine(row, claims.get(row.warrantyId) ?? null));
    result.set(row.orderItemId, list);
  }
  return result;
}

function ownedOrder(customerId: string) {
  return and(eq(orders.accountOwnerCustomerId, customerId), isNull(orders.deletedAt));
}

/** Active (not voided, not expired) warranties of the signed-in customer (the account "Warranties" tab). */
export async function countActiveBuyerWarranties(db: Database, customerId: string): Promise<number> {
  const row = await db
    .select({ count: sql<number>`count(*)` })
    .from(orderItemWarranties)
    .innerJoin(orders, eq(orders.id, orderItemWarranties.orderId))
    .where(and(
      ownedOrder(customerId),
      isNull(orderItemWarranties.voidedAt),
      gt(orderItemWarranties.expiresAt, nowSeconds()),
    ))
    .get();
  return Number(row?.count ?? 0);
}

export type BuyerWarrantyState = "active" | "expired" | "voided";

export interface BuyerWarranty extends LineWarrantyExtra {
  orderId: string;
  orderNumber: string;
  orderItemId: string;
  productId: string | null;
  productName: string | null;
  variantLabel: string | null;
  /** Public object key of the line's image, when it has one. */
  imageObjectKey: string | null;
  state: BuyerWarrantyState;
}

/**
 * Every warranty of the account's orders, newest handover first (at most
 * 100), active ones before ended ones.
 */
export async function listBuyerWarranties(
  db: Database,
  customerId: string,
  options: { now?: number } = {},
): Promise<BuyerWarranty[]> {
  const now = options.now ?? nowSeconds();
  const rows = await db
    .select({
      ...warrantySelect,
      orderNumber: orders.orderNumber,
      productId: orderItems.productId,
      productName: orderItems.productName,
      variantLabel: orderItems.variantLabel,
      imageObjectKey: sql<string | null>`CASE WHEN ${media.status} IN ('ready', 'trashed') THEN ${publishedMediaObjectKey()} END`,
    })
    .from(orderItemWarranties)
    .innerJoin(orders, eq(orders.id, orderItemWarranties.orderId))
    .innerJoin(orderItems, eq(orderItems.id, orderItemWarranties.orderItemId))
    .innerJoin(warrantyPolicyRevisions, eq(warrantyPolicyRevisions.id, orderItemWarranties.revisionId))
    .leftJoin(media, eq(media.id, orderItems.productImageMediaId))
    .where(ownedOrder(customerId))
    .orderBy(desc(orderItemWarranties.startsAt), desc(orderItemWarranties.id))
    .limit(BUYER_WARRANTIES_MAX)
    .all();
  const claims = await latestClaims(db, rows.map((row) => row.warrantyId));
  const items = rows.map((row): BuyerWarranty => {
    const state: BuyerWarrantyState = row.voidedAt !== null ? "voided" : row.expiresAt > now ? "active" : "expired";
    return {
      ...presentLine(row as WarrantyRow, claims.get(row.warrantyId) ?? null),
      orderId: row.orderId,
      orderNumber: formatOrderNumber(row.orderNumber, row.orderId),
      orderItemId: row.orderItemId,
      productId: row.productId ?? null,
      productName: row.productName ?? null,
      variantLabel: row.variantLabel ?? null,
      imageObjectKey: row.imageObjectKey ?? null,
      state,
    };
  });
  const rank = (state: BuyerWarrantyState) => (state === "active" ? 0 : 1);
  return items.sort((a, b) => rank(a.state) - rank(b.state));
}
