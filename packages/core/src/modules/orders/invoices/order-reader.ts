import { orderShippingAddressSelection } from "../shipping-address";
import { orderBillingAddressSelection } from "../billing-address";
import { and, asc, eq, notInArray, sql } from "drizzle-orm";

import type { Database } from "@scalius/database/client";
import {
  orderItems,
  orderPayments,
  orderReturnLines,
  orderReturns,
  orders,
  orderTaxSnapshots,
  PaymentRecordStatus,
} from "@scalius/database/schema";
import { fromMinor } from "@scalius/shared/money";
import type { InvoiceOrderSnapshot } from "./snapshot";
import { listOrderDiscountLines } from "../../promotions";
import { orderMoneyAmounts, orderMoneySelection } from "../money";
import { parseOrderLineProperties } from "../line-presentation";
import { readCheckoutAttributeApps } from "../../order-kernel";
import { readCheckoutAttributes } from "@scalius/shared/plugins/buyer-ui";

/**
 * Invoice-only order projection. This deliberately reads the product and
 * variant labels persisted on order_items instead of live catalog records.
 */
export interface InvoiceOrderSource extends InvoiceOrderSnapshot {
  deletedAt: number | null;
}

function completedRefundCondition(orderId: string) {
  return and(
    eq(orderPayments.orderId, orderId),
    eq(orderPayments.paymentType, "refund"),
    eq(orderPayments.status, PaymentRecordStatus.REFUNDED),
  );
}

/** Completed refunds in minor units; the issued snapshot owns currency precision. */
export async function readOrderRefundedMinor(db: Database, orderId: string): Promise<number> {
  const row = await db
    .select({
      refundedMinor: sql<number>`COALESCE(SUM(${orderPayments.amountMinor}), 0)`,
    })
    .from(orderPayments)
    .where(completedRefundCondition(orderId))
    .get();
  return Number(row?.refundedMinor) || 0;
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
      ...orderShippingAddressSelection(orders),
      ...orderBillingAddressSelection(orders),
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
      paymentTermsDays: orders.paymentTermsDays,
      paymentDueAt: orders.paymentDueAt,
      attributes: orders.attributes,
      // Bind the requested order: Drizzle unqualifies columns in a single-table
      // selection, which would resolve an outer id against the inner table.
      taxExempt: sql<number | null>`(SELECT ${orderTaxSnapshots.taxExempt} FROM ${orderTaxSnapshots} WHERE ${orderTaxSnapshots.orderId} = ${orderId})`,
      taxExemptionId: sql<string | null>`(SELECT ${orderTaxSnapshots.taxExemptionId} FROM ${orderTaxSnapshots} WHERE ${orderTaxSnapshots.orderId} = ${orderId})`,
      createdAt: sql<number>`CAST(${orders.createdAt} AS INTEGER)`,
      updatedAt: sql<number>`CAST(${orders.updatedAt} AS INTEGER)`,
      deletedAt: sql<number | null>`CAST(${orders.deletedAt} AS INTEGER)`,
      refundedMinor: sql<number>`COALESCE((
        SELECT SUM(${orderPayments.amountMinor}) FROM ${orderPayments}
        WHERE ${completedRefundCondition(orderId)}
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
      unitPriceMinor: orderItems.unitPriceMinor,
      lineSubtotalMinor: orderItems.lineSubtotalMinor,
      discountAmountMinor: orderItems.discountAmountMinor,
      taxableAmountMinor: orderItems.taxableAmountMinor,
      taxAmountMinor: orderItems.taxAmountMinor,
      properties: orderItems.properties,
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
    paymentTermsDays,
    paymentDueAt,
    taxExempt,
    taxExemptionId,
    attributes,
    ...orderFacts
  } = order;
  // The apps' answers and their words (one read, only when there are answers).
  const appAnswers = readCheckoutAttributes(attributes);
  const attributeApps = await readCheckoutAttributeApps(db, appAnswers);
  return {
    ...orderFacts,
    ...(Object.keys(appAnswers).length > 0 ? { appAnswers, attributeApps } : {}),
    taxExemption: Number(taxExempt) === 1 ? { exemptionId: taxExemptionId ?? null } : null,
    // Net terms as placed: the invoice prints them with the due date.
    paymentTerms: paymentTermsDays !== null && paymentDueAt
      ? { kind: "net", days: paymentTermsDays, dueAt: paymentDueAt.toISOString() }
      : null,
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
    items: items.map(({ properties, ...item }) => ({
      ...item,
      // The frozen buyer inputs, labels as the buyer saw them.
      properties: parseOrderLineProperties(properties),
      returnedQuantity: returnedByItem.get(item.id) ?? 0,
      price: fromMinor(item.unitPriceMinor, order.currencyDecimalPlaces),
    })),
  };
}
