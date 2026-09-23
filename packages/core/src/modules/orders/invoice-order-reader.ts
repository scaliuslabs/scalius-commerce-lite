import { asc, eq, sql } from "drizzle-orm";

import type { Database } from "@scalius/database/client";
import { orderItems, orders } from "@scalius/database/schema";
import { fromMinor } from "@scalius/shared/money";
import type { InvoiceOrderSnapshot } from "./invoice-snapshot";
import { orderMoneyAmounts, orderMoneySelection } from "./order-money";

/**
 * Invoice-only order projection. This deliberately reads the product and
 * variant labels persisted on order_items instead of live catalog records.
 */
export interface InvoiceOrderSource extends InvoiceOrderSnapshot {
  deletedAt: number | null;
}

export async function readInvoiceOrderSource(
  db: Database,
  orderId: string,
): Promise<InvoiceOrderSource | null> {
  const order = await db
    .select({
      id: orders.id,
      version: orders.version,
      customerName: orders.customerName,
      customerPhone: orders.customerPhone,
      customerEmail: orders.customerEmail,
      customerId: orders.customerId,
      shippingAddress: orders.shippingAddress,
      city: orders.city,
      zone: orders.zone,
      area: orders.area,
      cityName: orders.cityName,
      zoneName: orders.zoneName,
      areaName: orders.areaName,
      ...orderMoneySelection(orders),
      currencyCode: orders.currencyCode,
      subtotalAmountMinor: orders.subtotalAmountMinor,
      shippingMethodId: orders.shippingMethodId,
      shippingMethodName: orders.shippingMethodName,
      shippingMethodDescription: orders.shippingMethodDescription,
      shippingMethodBaseAmountMinor: orders.shippingMethodBaseAmountMinor,
      shippingFeeWaived: orders.shippingFeeWaived,
      taxAmountMinor: orders.taxAmountMinor,
      taxLabel: orders.taxLabel,
      pricesIncludeTax: orders.pricesIncludeTax,
      status: orders.status,
      paymentStatus: orders.paymentStatus,
      paymentMethod: orders.paymentMethod,
      fulfillmentStatus: orders.fulfillmentStatus,
      createdAt: sql<number>`CAST(${orders.createdAt} AS INTEGER)`,
      updatedAt: sql<number>`CAST(${orders.updatedAt} AS INTEGER)`,
      deletedAt: sql<number | null>`CAST(${orders.deletedAt} AS INTEGER)`,
    })
    .from(orders)
    .where(eq(orders.id, orderId))
    .get();
  if (!order) return null;

  const items = await db
    .select({
      id: orderItems.id,
      productId: orderItems.productId,
      variantId: orderItems.variantId,
      quantity: orderItems.quantity,
      productName: orderItems.productName,
      variantLabel: orderItems.variantLabel,
      fulfillmentStatus: orderItems.fulfillmentStatus,
      unitPriceMinor: orderItems.unitPriceMinor,
      lineSubtotalMinor: orderItems.lineSubtotalMinor,
      discountAmountMinor: orderItems.discountAmountMinor,
      taxableAmountMinor: orderItems.taxableAmountMinor,
      taxAmountMinor: orderItems.taxAmountMinor,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.createdAt), asc(orderItems.id));

  const { paidAmountMinor: _paidAmountMinor, balanceDueMinor: _balanceDueMinor, ...orderFacts } = order;
  return {
    ...orderFacts,
    ...orderMoneyAmounts(order),
    items: items.map((item) => ({
      ...item,
      price: fromMinor(item.unitPriceMinor, order.currencyDecimalPlaces),
    })),
  };
}
