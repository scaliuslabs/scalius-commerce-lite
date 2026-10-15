// The `data` of a webhook delivery: the resource's current admin API
// representation, read with the same core functions the admin GET routes use
// (orders/detail.ts, orders-returns.ts, products.ts, customers.ts,
// inventory.ts, inventory-purchasing.ts), so a receiver sees exactly what `GET /api/v1/admin/...`
// returns. A resource that no longer exists is null.

import type { Database } from "@scalius/database/client";
import { abandonedCheckouts, giftCards, giftCardTransactions, orderPayments, orders, user } from "@scalius/database/schema";
import { and, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { listGiftCardPaymentLinks } from "../routes/shared/gift-card-payment-links";
import { getShipment } from "@scalius/core/modules/delivery";
import { getPromotionAggregate, getPromotionOrderUsage } from "@scalius/core/modules/promotions";
import { getObjectEventRepresentation } from "@scalius/core/modules/objects";
import { getAdminReview } from "@scalius/core/modules/reviews";
import { getGiftCardForStaff } from "@scalius/core/modules/gift-cards";
import { getCurrentPublicMediaUrl } from "@scalius/core/integrations/storage";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { fromMinor } from "@scalius/shared/money";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { NotFoundError as CoreNotFoundError } from "@scalius/core/errors";
import type { OutboxEvent, WebhookRepresentationResolver } from "@scalius/core/modules/events";
import { getOrderDetails, getOrderReturn, listAdminOrderFulfilments } from "@scalius/core/modules/orders";
import { getProductDetails } from "@scalius/core/modules/product-admin";
import { getCustomerDetail } from "@scalius/core/modules/customers";
import { getPurchaseOrder, getTransfer, getVariantInventoryLevels } from "@scalius/core/modules/inventory";
import { composeOrderLineExtras, withOrderLineExtras } from "../routes/shared/order-line-extras";

async function orNullWhenMissing<T>(read: () => Promise<T | null | undefined>): Promise<T | null> {
  try {
    return (await read()) ?? null;
  } catch (error) {
    if (error instanceof CoreNotFoundError || (error as { status?: unknown })?.status === 404) return null;
    throw error;
  }
}

/** `GET /api/v1/admin/orders/{id}` */
export async function readAdminOrderRepresentation(db: Database, orderId: string): Promise<unknown | null> {
  const order = await getOrderDetails(db, orderId);
  if (!order) return null;
  const lineExtras = await composeOrderLineExtras(db, {
    orderId,
    orderItemIds: order.items.map((item) => item.id),
    audience: "staff",
    currencyDecimalPlaces: order.currencyDecimalPlaces ?? 2,
  });
  return { ...order, items: order.items.map((item) => withOrderLineExtras(item, lineExtras)) };
}

async function readAdminGiftCardRepresentation(db: Database, giftCardId: string) {
  const { giftCard, transactions } = await getGiftCardForStaff(db, giftCardId);
  const places = getDecimalPlaces(giftCard.currencyCode);
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
  return {
    giftCard: {
      ...giftCard,
      initialAmount: fromMinor(giftCard.initialAmountMinor, places),
      balance: fromMinor(giftCard.balanceMinor, places),
      expiresAt: giftCard.expiresAt === null ? null : iso(giftCard.expiresAt),
      createdAt: iso(giftCard.createdAt),
      sourceOrder: giftCard.sourceOrder
        ? { id: giftCard.sourceOrder.id, orderNumber: formatOrderNumber(giftCard.sourceOrder.orderNumber, giftCard.sourceOrder.id) }
        : null,
    },
    transactions: transactions.map((transaction) => ({
      ...transaction,
      amount: fromMinor(transaction.amountMinor, places),
      balanceAfter: fromMinor(transaction.balanceAfterMinor, places),
      orderNumber: transaction.orderId ? formatOrderNumber(transaction.orderNumber, transaction.orderId) : null,
      createdAt: iso(transaction.createdAt),
    })),
  };
}

async function readAdminPaymentRepresentation(db: Database, paymentId: string) {
  const payment = await db.select({
    id: orderPayments.id,
    orderId: orderPayments.orderId,
    amountMinor: orderPayments.amountMinor,
    currency: orderPayments.currency,
    paymentMethod: orderPayments.paymentMethod,
    paymentType: orderPayments.paymentType,
    status: orderPayments.status,
    providerRef: orderPayments.providerRef,
    providerSecondaryRef: orderPayments.providerSecondaryRef,
    codCollectedBy: orderPayments.codCollectedBy,
    codCollectedAt: orderPayments.codCollectedAt,
    codReceiptUrl: orderPayments.codReceiptUrl,
    createdAt: orderPayments.createdAt,
    updatedAt: orderPayments.updatedAt,
    currencyDecimalPlaces: orders.currencyDecimalPlaces,
  }).from(orderPayments).innerJoin(orders, eq(orders.id, orderPayments.orderId))
    .where(eq(orderPayments.id, paymentId)).get();
  if (!payment) return null;
  const { amountMinor, currencyDecimalPlaces, ...fields } = payment;
  const links = await listGiftCardPaymentLinks(db, fields.orderId, [fields]);
  return { ...fields, amount: fromMinor(amountMinor, currencyDecimalPlaces), giftCard: links.get(fields.id) ?? null };
}

export function createWebhookRepresentationResolver(db: Database): WebhookRepresentationResolver {
  return async (event: OutboxEvent) => {
    switch (event.resourceType) {
      case "order":
        return orNullWhenMissing(() => readAdminOrderRepresentation(db, event.resourceId));
      case "return": {
        // `GET /api/v1/admin/orders/{id}/returns/{returnId}` → `{ return }`
        const orderId = (event.facts as { orderId?: unknown }).orderId;
        if (typeof orderId !== "string") return null;
        return orNullWhenMissing(async () => ({ return: await getOrderReturn(db, orderId, event.resourceId) }));
      }
      case "fulfillment": {
        const orderId = (event.facts as { orderId?: unknown }).orderId;
        if (typeof orderId !== "string") return null;
        return orNullWhenMissing(async () => {
          const order = await db.select({ status: orders.status, currencyDecimalPlaces: orders.currencyDecimalPlaces })
            .from(orders).where(eq(orders.id, orderId)).get();
          if (!order) return null;
          return (await listAdminOrderFulfilments(db, orderId, order.currencyDecimalPlaces, order.status, event.resourceId))[0];
        });
      }
      case "shipment":
        return orNullWhenMissing(() => getShipment(db, event.resourceId));
      case "payment":
        return readAdminPaymentRepresentation(db, event.resourceId);
      case "checkout":
        return orNullWhenMissing(() => db.select().from(abandonedCheckouts).where(eq(abandonedCheckouts.id, event.resourceId)).get());
      case "discount":
        return orNullWhenMissing(async () => {
          const discount = await getPromotionAggregate(db, event.resourceId);
          return discount ? { ...discount, ...await getPromotionOrderUsage(db, discount.id) } : null;
        });
      case "review":
        return orNullWhenMissing(async () => {
          const { product, ...review } = await getAdminReview(db, event.resourceId);
          const { imageObjectKey, ...fields } = product;
          return { ...review, product: { ...fields, imageUrl: imageObjectKey ? getCurrentPublicMediaUrl(imageObjectKey) : null } };
        });
      case "gift_card":
        return orNullWhenMissing(() => readAdminGiftCardRepresentation(db, event.resourceId));
      case "transaction": {
        const giftCardId = (event.facts as { giftCardId?: unknown }).giftCardId;
        if (typeof giftCardId !== "string") return null;
        const actor = alias(user, "actor");
        const row = await db.select({
          id: giftCardTransactions.id,
          kind: giftCardTransactions.kind,
          amountMinor: giftCardTransactions.amountMinor,
          balanceAfterMinor: giftCardTransactions.balanceAfterMinor,
          orderId: giftCardTransactions.orderId,
          orderNumber: orders.orderNumber,
          actorType: giftCardTransactions.actorType,
          actorName: actor.name,
          reason: giftCardTransactions.reason,
          createdAt: giftCardTransactions.createdAt,
          currencyCode: giftCards.currencyCode,
        }).from(giftCardTransactions)
          .innerJoin(giftCards, eq(giftCards.id, giftCardTransactions.giftCardId))
          .leftJoin(orders, eq(orders.id, giftCardTransactions.orderId))
          .leftJoin(actor, and(eq(giftCardTransactions.actorType, "admin"), eq(actor.id, giftCardTransactions.actorId)))
          .where(and(eq(giftCardTransactions.id, event.resourceId), eq(giftCardTransactions.giftCardId, giftCardId))).get();
        if (!row) return null;
        const { currencyCode, ...transaction } = row;
        const places = getDecimalPlaces(currencyCode);
        return {
          ...transaction,
          amount: fromMinor(transaction.amountMinor, places),
          balanceAfter: fromMinor(transaction.balanceAfterMinor, places),
          orderNumber: transaction.orderId ? formatOrderNumber(transaction.orderNumber, transaction.orderId) : null,
          actorName: transaction.actorType === "admin" ? transaction.actorName : null,
          createdAt: new Date(transaction.createdAt * 1000).toISOString(),
        };
      }
      case "object": {
        const objectType = (event.facts as { objectType?: unknown }).objectType;
        if (typeof objectType !== "string") return null;
        return orNullWhenMissing(() => getObjectEventRepresentation(db, objectType, event.resourceId));
      }
      case "product":
        return orNullWhenMissing(() => getProductDetails(db, event.resourceId));
      case "customer":
        return orNullWhenMissing(() => getCustomerDetail(db, event.resourceId));
      case "variant":
        // `GET /api/v1/admin/inventory/{variantId}/levels`
        return orNullWhenMissing(() => getVariantInventoryLevels(db, event.resourceId));
      case "purchase_order":
        // `GET /api/v1/admin/inventory/purchase-orders/{purchaseOrderId}`
        return orNullWhenMissing(() => getPurchaseOrder(db, event.resourceId));
      case "inventory_transfer":
        // `GET /api/v1/admin/inventory/transfers/{transferId}`
        return orNullWhenMissing(() => getTransfer(db, event.resourceId));
    }
  };
}
