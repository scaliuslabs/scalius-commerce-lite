import { and, asc, eq, notInArray, sql } from "drizzle-orm";

import type { Database } from "@scalius/database/client";
import {
  orderItems,
  orderPayments,
  orderReturnLines,
  orderReturns,
  orders,
  PaymentRecordStatus,
} from "@scalius/database/schema";
import { fromMinor } from "@scalius/shared/money";
import type { InvoiceOrderSnapshot } from "./invoice-snapshot";
import { listOrderDiscountLines } from "../promotions/order-discount-lines";
import { orderMoneyAmounts, orderMoneySelection } from "./order-money";

/**
 * Invoice-only order projection. This deliberately reads the product and
 * variant labels persisted on order_items instead of live catalog records.
 */
export interface InvoiceOrderSource extends InvoiceOrderSnapshot {
  deletedAt: number | null;
}

/** Money given back on the order so far (major units), for invoices issued before a refund. */
export async function readOrderRefundedAmount(db: Database, orderId: string): Promise<number> {
  const row = await db
    .select({
      refundedMinor: sql<number>`COALESCE(SUM(${orderPayments.amountMinor}), 0)`,
      decimals: sql<number>`(SELECT ${orders.currencyDecimalPlaces} FROM ${orders} WHERE ${orders.id} = ${orderId})`,
    })
    .from(orderPayments)
    .where(and(
      eq(orderPayments.orderId, orderId),
      eq(orderPayments.paymentType, "refund"),
      eq(orderPayments.status, PaymentRecordStatus.REFUNDED),
    ))
    .get();
  return fromMinor(Number(row?.refundedMinor) || 0, Number(row?.decimals ?? 2));
}

export async function readInvoiceOrderSource(
  db: Database,
  orderId: string,
): Promise<InvoiceOrderSource | null> {
  const order = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
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
      refundedMinor: sql<number>`COALESCE((
        SELECT SUM(${orderPayments.amountMinor}) FROM ${orderPayments}
        WHERE ${orderPayments.orderId} = ${orders.id}
          AND ${orderPayments.paymentType} = 'refund'
          AND ${orderPayments.status} = ${PaymentRecordStatus.REFUNDED}
      ), 0)`,
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

  // Units received back on open or finished returns, per line.
  const returnedRows = await db
    .select({
      orderItemId: orderReturnLines.orderItemId,
      quantity: sql<number>`SUM(${orderReturnLines.receivedQuantity})`,
    })
    .from(orderReturnLines)
    .innerJoin(orderReturns, eq(orderReturns.id, orderReturnLines.returnId))
    .where(and(
      eq(orderReturnLines.orderId, orderId),
      notInArray(orderReturns.status, ["cancelled", "rejected"]),
    ))
    .groupBy(orderReturnLines.orderItemId);
  const returnedByItem = new Map(returnedRows.map((row) => [row.orderItemId, Number(row.quantity) || 0]));

  const discountRows = await listOrderDiscountLines(db, orderId);

  const {
    paidAmountMinor: _paidAmountMinor,
    balanceDueMinor: _balanceDueMinor,
    refundedMinor,
    ...orderFacts
  } = order;
  return {
    ...orderFacts,
    ...orderMoneyAmounts(order),
    refundedAmount: fromMinor(Number(refundedMinor) || 0, order.currencyDecimalPlaces),
    // As on the order page: `amount` is everything saved, `shippingAmount` the part off delivery.
    discounts: discountRows.map((row) => ({
      name: row.title,
      code: row.code,
      kind: row.kind,
      amount: fromMinor(row.amountMinor + row.shippingAmountMinor, order.currencyDecimalPlaces),
      shippingAmount: fromMinor(row.shippingAmountMinor, order.currencyDecimalPlaces),
    })),
    items: items.map((item) => ({
      ...item,
      returnedQuantity: returnedByItem.get(item.id) ?? 0,
      price: fromMinor(item.unitPriceMinor, order.currencyDecimalPlaces),
    })),
  };
}
