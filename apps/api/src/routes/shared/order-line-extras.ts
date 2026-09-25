// Per-order-line "extras" (Wave B design §7.1, §14 decision 29): the review
// state, downloads, licence keys, issued gift cards and warranty records of
// each order item, composed here at the API layer from the four feature
// domains' public entries. Composing them inside `orders` would pull those
// domains into the order cycle group.
//
// Callers have already proven access to the order (receipt proof, account
// ownership or staff permission) and pass its item ids. An item gets an
// `extras` key only when some domain returned a fact for it, so responses are
// byte-identical while the domains are empty.
import { z } from "@hono/zod-openapi";
import type { Database } from "@scalius/database/client";
import { listLineDeliveries } from "@scalius/core/modules/digital";
import { listLineIssuedCards, listOrderGiftCardTenders } from "@scalius/core/modules/gift-cards";
import { listLineReviewStates, type LineExtrasInput } from "@scalius/core/modules/reviews";
import { listLineWarranties } from "@scalius/core/modules/warranty";
import { fromMinor } from "@scalius/shared/money";

const isoTimestamp = z.string().openapi({ format: "date-time" });

export const orderLineReviewExtraSchema = z.object({
  eligible: z.boolean(),
  review: z.object({
    id: z.string(),
    rating: z.number().int().min(1).max(5),
    status: z.string(),
  }).nullable(),
}).openapi("OrderLineReviewExtra");

export const orderLineDownloadExtraSchema = z.object({
  entitlementId: z.string(),
  displayName: z.string(),
  downloadCount: z.number().int().nonnegative(),
  downloadLimit: z.number().int().positive().nullable(),
  expiresAt: isoTimestamp.nullable(),
  revoked: z.boolean(),
}).openapi("OrderLineDownloadExtra");

export const orderLineLicenceKeyExtraSchema = z.object({
  keyId: z.string(),
  last4: z.string(),
}).openapi("OrderLineLicenceKeyExtra");

export const orderLineGiftCardExtraSchema = z.object({
  giftCardId: z.string(),
  last4: z.string(),
  initialAmount: z.number(),
  initialAmountMinor: z.number().int(),
  currencyCode: z.string(),
  sentTo: z.string().nullable(),
}).openapi("OrderLineGiftCardExtra");

export const orderLineWarrantyExtraSchema = z.object({
  warrantyId: z.string(),
  policyName: z.string(),
  provider: z.string(),
  quantity: z.number().int().positive(),
  startsAt: isoTimestamp,
  expiresAt: isoTimestamp,
  replacementUntil: isoTimestamp.nullable(),
  voided: z.boolean(),
  openClaimId: z.string().nullable(),
}).openapi("OrderLineWarrantyExtra");

export const orderLineExtrasSchema = z.object({
  review: orderLineReviewExtraSchema.optional(),
  downloads: z.array(orderLineDownloadExtraSchema).optional(),
  licenceKeys: z.array(orderLineLicenceKeyExtraSchema).optional(),
  giftCards: z.array(orderLineGiftCardExtraSchema).optional(),
  warranty: z.array(orderLineWarrantyExtraSchema).optional(),
}).openapi("OrderLineExtras");

/** Spread into an order item object schema: the item may carry `extras`. */
export const orderLineExtrasShape = {
  extras: orderLineExtrasSchema.optional(),
};

export type OrderLineExtras = z.infer<typeof orderLineExtrasSchema>;

function isoFromEpochSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function lineExtras(map: Map<string, OrderLineExtras>, orderItemId: string): OrderLineExtras {
  let extras = map.get(orderItemId);
  if (!extras) {
    extras = {};
    map.set(orderItemId, extras);
  }
  return extras;
}

/**
 * Reads every domain's extras for the order's lines, keyed by order item id.
 * The four readers run one after another (never in parallel), so an order
 * page adds at most a few bounded reads and stays within D1's six
 * connections. Nothing is read for an order without items.
 */
export async function composeOrderLineExtras(
  db: Database,
  input: LineExtrasInput & { currencyDecimalPlaces: number },
): Promise<ReadonlyMap<string, OrderLineExtras>> {
  const composed = new Map<string, OrderLineExtras>();
  if (input.orderItemIds.length === 0) return composed;
  const lines: LineExtrasInput = {
    orderId: input.orderId,
    orderItemIds: input.orderItemIds,
    audience: input.audience,
  };

  for (const [orderItemId, review] of await listLineReviewStates(db, lines)) {
    lineExtras(composed, orderItemId).review = review;
  }
  for (const [orderItemId, delivery] of await listLineDeliveries(db, lines)) {
    const extras = lineExtras(composed, orderItemId);
    if (delivery.downloads.length > 0) {
      extras.downloads = delivery.downloads.map((download) => ({
        ...download,
        expiresAt: download.expiresAt === null ? null : isoFromEpochSeconds(download.expiresAt),
      }));
    }
    if (delivery.licenceKeys.length > 0) extras.licenceKeys = [...delivery.licenceKeys];
  }
  for (const [orderItemId, cards] of await listLineIssuedCards(db, lines)) {
    if (cards.length === 0) continue;
    lineExtras(composed, orderItemId).giftCards = cards.map((card) => ({
      ...card,
      initialAmount: fromMinor(card.initialAmountMinor, input.currencyDecimalPlaces),
    }));
  }
  for (const [orderItemId, warranties] of await listLineWarranties(db, lines)) {
    if (warranties.length === 0) continue;
    lineExtras(composed, orderItemId).warranty = warranties.map((warranty) => ({
      ...warranty,
      startsAt: isoFromEpochSeconds(warranty.startsAt),
      expiresAt: isoFromEpochSeconds(warranty.expiresAt),
      replacementUntil: warranty.replacementUntil === null ? null : isoFromEpochSeconds(warranty.replacementUntil),
    }));
  }

  for (const [orderItemId, extras] of composed) {
    if (Object.keys(extras).length === 0) composed.delete(orderItemId);
  }
  return composed;
}

/** The item with `extras` added only when the line has any. */
export function withOrderLineExtras<T extends { id: string }>(
  item: T,
  extras: ReadonlyMap<string, OrderLineExtras>,
): T & { extras?: OrderLineExtras } {
  const lineExtrasForItem = extras.get(item.id);
  return lineExtrasForItem ? { ...item, extras: lineExtrasForItem } : item;
}

/** The gift cards still paying for an order (receipt and account order page): last 4 and amount only. */
export const orderGiftCardTenderSchema = z.object({
  last4: z.string(),
  amount: z.number(),
  amountMinor: z.number().int(),
}).openapi("OrderGiftCardTender");

export async function presentOrderGiftCardTenders(
  db: Database,
  orderId: string,
  currencyDecimalPlaces: number,
): Promise<Array<z.infer<typeof orderGiftCardTenderSchema>>> {
  const tenders = await listOrderGiftCardTenders(db, orderId);
  return tenders.map((tender) => ({
    last4: tender.last4,
    amount: fromMinor(tender.amountMinor, currencyDecimalPlaces),
    amountMinor: tender.amountMinor,
  }));
}
