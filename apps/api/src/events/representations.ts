// The `data` of a webhook delivery: the resource's current admin API
// representation, read with the same core functions the admin GET routes use
// (orders/detail.ts, orders-returns.ts, products.ts, customers.ts,
// inventory.ts, inventory-purchasing.ts), so a receiver sees exactly what `GET /api/v1/admin/...`
// returns. A resource that no longer exists is null.

import type { Database } from "@scalius/database/client";
import { NotFoundError as CoreNotFoundError } from "@scalius/core/errors";
import type { OutboxEvent, WebhookRepresentationResolver } from "@scalius/core/modules/events";
import { getOrderDetails, getOrderReturn } from "@scalius/core/modules/orders";
import { getProductDetails } from "@scalius/core/modules/products";
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
