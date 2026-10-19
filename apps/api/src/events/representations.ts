// The `data` of a webhook delivery (COMMERCE-HOOKS H5): each resource type's
// sealed representation (`EVENT_REPRESENTATION_SCHEMAS`, @scalius/shared/events),
// read here with a few indexed queries and built only through
// `buildEventRepresentation`, so nothing the schema does not declare can leave
// the store. It is resolved in full; the delivery then reads the protected
// fields its subscription did not opt in to as null. A resource that no
// longer exists is null.

import type { Database } from "@scalius/database/client";
import {
  abandonedCheckouts,
  customerMarketingConsents,
  customers,
  deliveryShipments,
  giftCardTransactions,
  giftCards,
  inventoryLevels,
  inventoryTransferLines,
  inventoryTransfers,
  orderFulfillmentLines,
  orderFulfillments,
  orderItems,
  orderPayments,
  orderReturnLines,
  orderReturns,
  orders,
  productReviews,
  productVariants,
  products,
  promotionCodes,
  promotionRedemptions,
  promotions,
  purchaseOrderLines,
  purchaseOrders,
} from "@scalius/database/schema";
import { and, asc, count, eq, isNull } from "drizzle-orm";
import { getObjectEventRepresentation } from "@scalius/core/modules/objects";
import { readStoreCurrency } from "@scalius/core/modules/markets";
import type { OutboxEvent, WebhookRepresentationResolver } from "@scalius/core/modules/events";
import {
  buildEventRepresentation,
  type EventRepresentation,
  type EventRepresentationInput,
  type EventRepresentationType,
} from "@scalius/shared/events";
import { allProtectedData } from "@scalius/shared/plugins/protected-data";

/** The most lines a representation lists (an order's, a return's, a purchase order's): a bigger one is truncated as a whole. */
const MAX_LINES = 500;

/** ISO 8601 from a timestamp column (a Date) or a seconds column (a number). */
function iso(value: Date | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(Number(value) * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
const isoRequired = (value: Date | number) => iso(value) ?? new Date(0).toISOString();

function sealed<T extends EventRepresentationType>(type: T, value: EventRepresentationInput<T>): EventRepresentation<T> {
  return buildEventRepresentation(type, value, allProtectedData());
}

type OrderRow = typeof orders.$inferSelect;

function shippingAddress(order: OrderRow) {
  return {
    name: order.shippingName ?? order.customerName ?? null,
    phone: order.shippingPhone ?? order.customerPhone ?? null,
    company: order.shippingCompany ?? null,
    line1: order.shippingAddress ?? null,
    line2: order.shippingAddressLine2 ?? null,
    dependentLocality: order.shippingDependentLocality ?? null,
    locality: order.shippingLocality ?? order.cityName ?? null,
    adminArea: order.shippingAdminArea ?? null,
    postalCode: order.shippingPostalCode ?? null,
    countryCode: order.shippingCountryCode ?? null,
    placeIds: { city: order.city ?? null, zone: order.zone ?? null, area: order.area ?? null },
  };
}

function billingAddress(order: OrderRow) {
  if (order.billingSameAsShipping || !order.billingCountryCode) return null;
  return {
    name: order.billingName ?? null,
    phone: order.billingPhone ?? null,
    company: order.billingCompany ?? null,
    line1: order.billingAddress ?? null,
    line2: order.billingAddressLine2 ?? null,
    dependentLocality: order.billingDependentLocality ?? null,
    locality: order.billingLocality ?? null,
    adminArea: order.billingAdminArea ?? null,
    postalCode: order.billingPostalCode ?? null,
    countryCode: order.billingCountryCode,
    placeIds: { city: null, zone: null, area: null },
  };
}

async function orderRepresentation(db: Database, orderId: string) {
  const order = await db.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!order) return null;
  const lines = await db.select({
    id: orderItems.id,
    productId: orderItems.productId,
    variantId: orderItems.variantId,
    title: orderItems.productName,
    variantLabel: orderItems.variantLabel,
    quantity: orderItems.quantity,
    fulfilledQuantity: orderItems.fulfilledQuantity,
    unitPriceMinor: orderItems.unitPriceMinor,
    subtotalMinor: orderItems.lineSubtotalMinor,
    discountMinor: orderItems.discountAmountMinor,
    taxMinor: orderItems.taxAmountMinor,
  }).from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(asc(orderItems.createdAt), asc(orderItems.id)).limit(MAX_LINES).all();
  return sealed("order", {
    id: order.id,
    orderNumber: order.orderNumber ?? null,
    status: order.status,
    paymentStatus: order.paymentStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    channel: order.channel,
    salesChannelId: order.salesChannelId,
    marketId: order.marketId ?? null,
    currency: order.currencyCode,
    subtotalMinor: order.subtotalAmountMinor,
    shippingMinor: order.shippingAmountMinor,
    discountMinor: order.discountAmountMinor,
    taxMinor: order.taxAmountMinor,
    totalMinor: order.totalAmountMinor,
    paidMinor: order.paidAmountMinor,
    balanceDueMinor: order.balanceDueMinor,
    pricesIncludeTax: Boolean(order.pricesIncludeTax),
    paymentMethod: order.paymentMethod ?? null,
    customerId: order.customerId ?? null,
    contact: { name: order.customerName ?? null, email: order.customerEmail ?? null, phone: order.customerPhone ?? null },
    requiresShipping: Boolean(order.requiresShipping),
    shippingMethodId: order.shippingMethodId ?? null,
    shippingAddress: order.requiresShipping ? shippingAddress(order) : null,
    billingAddress: billingAddress(order),
    fulfillmentLocationId: order.fulfillmentLocationId ?? null,
    lines: lines.map((line) => ({
      ...line,
      unitPriceMinor: line.unitPriceMinor ?? 0,
      subtotalMinor: line.subtotalMinor ?? 0,
      discountMinor: line.discountMinor ?? 0,
      taxMinor: line.taxMinor ?? 0,
      fulfilledQuantity: line.fulfilledQuantity ?? 0,
    })),
    createdAt: isoRequired(order.createdAt),
    updatedAt: isoRequired(order.updatedAt),
    deletedAt: iso(order.deletedAt),
  });
}

async function returnRepresentation(db: Database, returnId: string) {
  const row = await db.select().from(orderReturns).where(eq(orderReturns.id, returnId)).get();
  if (!row) return null;
  const lines = await db.select().from(orderReturnLines).where(eq(orderReturnLines.returnId, returnId)).limit(MAX_LINES).all();
  return sealed("return", {
    id: row.id,
    orderId: row.orderId,
    status: row.status,
    reason: row.reason,
    source: row.source,
    version: row.version,
    requestedAt: isoRequired(row.requestedAt),
    approvedAt: iso(row.approvedAt),
    completedAt: iso(row.completedAt),
    rejectedAt: iso(row.rejectedAt),
    cancelledAt: iso(row.cancelledAt),
    lines: lines.map((line) => ({
      id: line.id,
      orderItemId: line.orderItemId,
      variantId: line.variantId ?? null,
      requestedQuantity: line.requestedQuantity,
      approvedQuantity: line.approvedQuantity,
      receivedQuantity: line.receivedQuantity,
      restockQuantity: line.restockQuantity,
      damagedQuantity: line.damagedQuantity,
      rejectedQuantity: line.rejectedQuantity,
    })),
    createdAt: isoRequired(row.createdAt),
    updatedAt: isoRequired(row.updatedAt),
  });
}

async function productRepresentation(db: Database, productId: string) {
  const product = await db.select().from(products).where(eq(products.id, productId)).get();
  if (!product) return null;
  const [variants, currency] = await Promise.all([
    db.select({
      id: productVariants.id,
      sku: productVariants.sku,
      priceMinor: productVariants.priceMinor,
      barcode: productVariants.barcode,
      trackInventory: productVariants.trackInventory,
      fulfillmentKind: productVariants.fulfillmentKind,
      isDefault: productVariants.isDefault,
    }).from(productVariants)
      .where(and(eq(productVariants.productId, productId), isNull(productVariants.deletedAt)))
      .orderBy(asc(productVariants.createdAt), asc(productVariants.id)).limit(MAX_LINES).all(),
    readStoreCurrency(db),
  ]);
  return sealed("product", {
    id: product.id,
    name: product.name,
    slug: product.slug,
    status: product.deletedAt ? "trashed" : product.isActive ? "active" : "draft",
    brandId: product.brandId ?? null,
    categoryId: product.categoryId ?? null,
    revision: product.aggregateRevision,
    isGiftCard: Boolean(product.isGiftCard),
    currency: currency.code,
    priceMinor: product.priceMinor,
    variants: variants.map((variant) => ({ ...variant, barcode: variant.barcode ?? null })),
    createdAt: isoRequired(product.createdAt),
    updatedAt: isoRequired(product.updatedAt),
    deletedAt: iso(product.deletedAt),
  });
}

async function variantRepresentation(db: Database, variantId: string) {
  const variant = await db.select({
    id: productVariants.id,
    productId: productVariants.productId,
    sku: productVariants.sku,
    trackInventory: productVariants.trackInventory,
    stock: productVariants.stock,
    updatedAt: productVariants.updatedAt,
  }).from(productVariants).where(eq(productVariants.id, variantId)).get();
  if (!variant) return null;
  const levels = await db.select({ locationId: inventoryLevels.locationId, onHand: inventoryLevels.onHand })
    .from(inventoryLevels).where(eq(inventoryLevels.variantId, variantId)).orderBy(asc(inventoryLevels.locationId)).all();
  return sealed("variant", {
    id: variant.id,
    productId: variant.productId,
    sku: variant.sku,
    trackInventory: variant.trackInventory,
    onHand: variant.stock,
    levels,
    updatedAt: isoRequired(variant.updatedAt),
  });
}

async function customerRepresentation(db: Database, customerId: string) {
  const customer = await db.select().from(customers).where(eq(customers.id, customerId)).get();
  if (!customer) return null;
  const consents = await db.select({
    channel: customerMarketingConsents.channel,
    state: customerMarketingConsents.state,
    contact: customerMarketingConsents.contact,
    updatedAt: customerMarketingConsents.updatedAt,
  }).from(customerMarketingConsents).where(eq(customerMarketingConsents.customerId, customerId))
    .orderBy(asc(customerMarketingConsents.channel)).all();
  return sealed("customer", {
    id: customer.id,
    name: customer.name ?? null,
    email: customer.email ?? null,
    phone: (customer.phone as string | null) ?? null,
    hasAccount: customer.accountClaimedAt !== null && customer.accountClaimedAt !== undefined,
    totalOrders: customer.totalOrders,
    lastOrderAt: iso(customer.lastOrderAt),
    mergedIntoCustomerId: customer.mergedIntoCustomerId ?? null,
    consents: consents.map((consent) => ({ ...consent, contact: consent.contact || null, updatedAt: isoRequired(consent.updatedAt) })),
    createdAt: isoRequired(customer.createdAt),
    updatedAt: isoRequired(customer.updatedAt),
    deletedAt: iso(customer.deletedAt),
  });
}

async function purchaseOrderRepresentation(db: Database, purchaseOrderId: string) {
  const order = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, purchaseOrderId)).get();
  if (!order) return null;
  const lines = await db.select({
    id: purchaseOrderLines.id,
    variantId: purchaseOrderLines.variantId,
    quantity: purchaseOrderLines.quantity,
    receivedQuantity: purchaseOrderLines.receivedQuantity,
    unitCostMinor: purchaseOrderLines.unitCostMinor,
  }).from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId))
    .orderBy(asc(purchaseOrderLines.position)).limit(MAX_LINES).all();
  return sealed("purchase_order", {
    id: order.id,
    number: order.number,
    status: order.status,
    supplierId: order.supplierId ?? null,
    destinationLocationId: order.destinationLocationId,
    reference: order.reference ?? null,
    expectedOn: order.expectedOn ?? null,
    currency: order.currencyCode,
    shippingMinor: order.shippingMinor,
    otherCostsMinor: order.otherCostsMinor,
    taxMinor: order.taxMinor,
    revision: order.revision,
    lines,
    orderedAt: iso(order.orderedAt),
    receivedAt: iso(order.receivedAt),
    cancelledAt: iso(order.cancelledAt),
    createdAt: isoRequired(order.createdAt),
    updatedAt: isoRequired(order.updatedAt),
  });
}

async function transferRepresentation(db: Database, transferId: string) {
  const transfer = await db.select().from(inventoryTransfers).where(eq(inventoryTransfers.id, transferId)).get();
  if (!transfer) return null;
  const lines = await db.select({
    id: inventoryTransferLines.id,
    variantId: inventoryTransferLines.variantId,
    quantity: inventoryTransferLines.quantity,
    shippedQuantity: inventoryTransferLines.shippedQuantity,
    receivedQuantity: inventoryTransferLines.receivedQuantity,
    returnedQuantity: inventoryTransferLines.returnedQuantity,
  }).from(inventoryTransferLines).where(eq(inventoryTransferLines.transferId, transferId))
    .orderBy(asc(inventoryTransferLines.position)).limit(MAX_LINES).all();
  return sealed("inventory_transfer", {
    id: transfer.id,
    number: transfer.number,
    status: transfer.status,
    originLocationId: transfer.originLocationId,
    destinationLocationId: transfer.destinationLocationId,
    reference: transfer.reference ?? null,
    expectedOn: transfer.expectedOn ?? null,
    revision: transfer.revision,
    lines,
    shippedAt: iso(transfer.shippedAt),
    receivedAt: iso(transfer.receivedAt),
    cancelledAt: iso(transfer.cancelledAt),
    createdAt: isoRequired(transfer.createdAt),
    updatedAt: isoRequired(transfer.updatedAt),
  });
}

async function fulfillmentRepresentation(db: Database, fulfillmentId: string) {
  const row = await db.select({
    id: orderFulfillments.id,
    orderId: orderFulfillments.orderId,
    kind: orderFulfillments.kind,
    status: orderFulfillments.status,
    shipmentId: orderFulfillments.shipmentId,
    locationId: orderFulfillments.locationId,
    cashCollectedMinor: orderFulfillments.cashCollectedMinor,
    createdAt: orderFulfillments.createdAt,
    voidedAt: orderFulfillments.voidedAt,
    currency: orders.currencyCode,
  }).from(orderFulfillments).innerJoin(orders, eq(orders.id, orderFulfillments.orderId))
    .where(eq(orderFulfillments.id, fulfillmentId)).get();
  if (!row) return null;
  const lines = await db.select({ id: orderFulfillmentLines.id, orderItemId: orderFulfillmentLines.orderItemId, quantity: orderFulfillmentLines.quantity })
    .from(orderFulfillmentLines).where(eq(orderFulfillmentLines.fulfillmentId, fulfillmentId)).limit(MAX_LINES).all();
  return sealed("fulfillment", {
    ...row,
    shipmentId: row.shipmentId ?? null,
    locationId: row.locationId ?? null,
    cashCollectedMinor: row.cashCollectedMinor ?? null,
    lines,
    createdAt: isoRequired(row.createdAt),
    voidedAt: iso(row.voidedAt),
  });
}

async function shipmentRepresentation(db: Database, shipmentId: string) {
  const row = await db.select({
    id: deliveryShipments.id,
    orderId: deliveryShipments.orderId,
    providerId: deliveryShipments.providerId,
    providerType: deliveryShipments.providerType,
    status: deliveryShipments.status,
    rawStatus: deliveryShipments.rawStatus,
    externalId: deliveryShipments.externalId,
    trackingId: deliveryShipments.trackingId,
    trackingUrl: deliveryShipments.trackingUrl,
    courierName: deliveryShipments.courierName,
    amountMinor: deliveryShipments.shipmentAmountMinor,
    isFinal: deliveryShipments.isFinalShipment,
    lastChecked: deliveryShipments.lastChecked,
    createdAt: deliveryShipments.createdAt,
    updatedAt: deliveryShipments.updatedAt,
    currency: orders.currencyCode,
  }).from(deliveryShipments).innerJoin(orders, eq(orders.id, deliveryShipments.orderId))
    .where(eq(deliveryShipments.id, shipmentId)).get();
  if (!row) return null;
  const { lastChecked, ...fields } = row;
  return sealed("shipment", {
    ...fields,
    providerId: fields.providerId ?? null,
    rawStatus: fields.rawStatus ?? null,
    externalId: fields.externalId ?? null,
    trackingId: fields.trackingId ?? null,
    trackingUrl: fields.trackingUrl ?? null,
    courierName: fields.courierName ?? null,
    amountMinor: fields.amountMinor ?? null,
    lastCheckedAt: iso(lastChecked),
    createdAt: isoRequired(fields.createdAt),
    updatedAt: isoRequired(fields.updatedAt),
  });
}

async function paymentRepresentation(db: Database, paymentId: string) {
  const row = await db.select().from(orderPayments).where(eq(orderPayments.id, paymentId)).get();
  if (!row) return null;
  return sealed("payment", {
    id: row.id,
    orderId: row.orderId,
    status: row.status,
    method: row.paymentMethod,
    type: row.paymentType,
    currency: row.currency,
    amountMinor: row.amountMinor,
    settlementCurrency: row.settlementCurrency,
    settlementAmountMinor: row.settlementAmountMinor,
    providerRef: row.providerRef ?? null,
    createdAt: isoRequired(row.createdAt),
    updatedAt: isoRequired(row.updatedAt),
  });
}

async function checkoutRepresentation(db: Database, abandonedCheckoutId: string) {
  const row = await db.select({
    id: abandonedCheckouts.id,
    checkoutId: abandonedCheckouts.checkoutId,
    phone: abandonedCheckouts.customerPhone,
    abandonedAt: abandonedCheckouts.abandonedAt,
    createdAt: abandonedCheckouts.createdAt,
    updatedAt: abandonedCheckouts.updatedAt,
  }).from(abandonedCheckouts).where(eq(abandonedCheckouts.id, abandonedCheckoutId)).get();
  if (!row) return null;
  return sealed("checkout", {
    ...row,
    phone: row.phone ?? null,
    abandonedAt: iso(row.abandonedAt),
    createdAt: isoRequired(row.createdAt),
    updatedAt: isoRequired(row.updatedAt),
  });
}

async function discountRepresentation(db: Database, promotionId: string) {
  const promotion = await db.select().from(promotions).where(eq(promotions.id, promotionId)).get();
  if (!promotion) return null;
  const [codes, redemptions] = await Promise.all([
    db.select({ count: count() }).from(promotionCodes).where(eq(promotionCodes.promotionId, promotionId)).get(),
    db.select({ count: count() }).from(promotionRedemptions).where(eq(promotionRedemptions.promotionId, promotionId)).get(),
  ]);
  return sealed("discount", {
    id: promotion.id,
    name: promotion.name,
    title: promotion.title ?? null,
    method: promotion.method,
    status: promotion.status,
    priority: promotion.priority,
    revision: promotion.revision,
    codeCount: Number(codes?.count ?? 0),
    startsAt: iso(promotion.startsAt),
    endsAt: iso(promotion.endsAt),
    maxRedemptions: promotion.maxRedemptions ?? null,
    redemptions: Number(redemptions?.count ?? 0),
    createdAt: isoRequired(promotion.createdAt),
    updatedAt: isoRequired(promotion.updatedAt),
    deletedAt: iso(promotion.deletedAt),
  });
}

async function reviewRepresentation(db: Database, reviewId: string) {
  const review = await db.select().from(productReviews).where(eq(productReviews.id, reviewId)).get();
  if (!review) return null;
  return sealed("review", {
    id: review.id,
    productId: review.productId,
    variantId: review.variantId ?? null,
    orderId: review.orderId ?? null,
    customerId: review.customerId ?? null,
    status: review.status,
    rating: review.rating,
    title: review.title ?? null,
    body: review.body ?? null,
    authorDisplayName: review.authorDisplayName ?? null,
    publishedAt: iso(review.publishedAt),
    repliedAt: iso(review.repliedAt),
    version: review.version,
    createdAt: isoRequired(review.createdAt),
    updatedAt: isoRequired(review.updatedAt),
  });
}

async function giftCardRepresentation(db: Database, giftCardId: string) {
  const card = await db.select().from(giftCards).where(eq(giftCards.id, giftCardId)).get();
  if (!card) return null;
  return sealed("gift_card", {
    id: card.id,
    last4: card.codeLast4,
    status: card.status,
    currency: card.currencyCode,
    initialAmountMinor: card.initialAmountMinor,
    balanceMinor: card.balanceMinor,
    source: card.source,
    sourceOrderId: card.sourceOrderId ?? null,
    customerId: card.customerId ?? null,
    recipient: { name: card.recipientName ?? null, email: card.recipientEmail ?? null, phone: card.recipientPhone ?? null },
    expiresAt: iso(card.expiresAt),
    version: card.version,
    createdAt: isoRequired(card.createdAt),
    updatedAt: isoRequired(card.updatedAt),
  });
}

async function transactionRepresentation(db: Database, transactionId: string, giftCardId: string) {
  const row = await db.select({
    id: giftCardTransactions.id,
    giftCardId: giftCardTransactions.giftCardId,
    kind: giftCardTransactions.kind,
    amountMinor: giftCardTransactions.amountMinor,
    balanceAfterMinor: giftCardTransactions.balanceAfterMinor,
    orderId: giftCardTransactions.orderId,
    actorType: giftCardTransactions.actorType,
    createdAt: giftCardTransactions.createdAt,
    currency: giftCards.currencyCode,
  }).from(giftCardTransactions).innerJoin(giftCards, eq(giftCards.id, giftCardTransactions.giftCardId))
    .where(and(eq(giftCardTransactions.id, transactionId), eq(giftCardTransactions.giftCardId, giftCardId))).get();
  if (!row) return null;
  return sealed("transaction", { ...row, orderId: row.orderId ?? null, createdAt: isoRequired(row.createdAt) });
}

async function objectRepresentation(db: Database, objectType: string, objectId: string) {
  const record = await getObjectEventRepresentation(db, objectType, objectId).catch(() => null);
  if (!record) return null;
  return sealed("object", {
    id: record.id,
    type: record.typeId,
    handle: record.handle,
    status: record.status,
    revision: record.revision,
    data: record.data,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

const factString = (event: OutboxEvent, key: string): string | null => {
  const value = (event.facts as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
};

/** Each event's sealed representation, in full; the delivery applies its subscription's customer data. */
export function createWebhookRepresentationResolver(db: Database): WebhookRepresentationResolver {
  return async (event: OutboxEvent): Promise<EventRepresentation | null> => {
    switch (event.resourceType) {
      case "order":
        return orderRepresentation(db, event.resourceId);
      case "return":
        return returnRepresentation(db, event.resourceId);
      case "product":
        return productRepresentation(db, event.resourceId);
      case "variant":
        return variantRepresentation(db, event.resourceId);
      case "customer":
        return customerRepresentation(db, event.resourceId);
      case "purchase_order":
        return purchaseOrderRepresentation(db, event.resourceId);
      case "inventory_transfer":
        return transferRepresentation(db, event.resourceId);
      case "fulfillment":
        return fulfillmentRepresentation(db, event.resourceId);
      case "shipment":
        return shipmentRepresentation(db, event.resourceId);
      case "payment":
        return paymentRepresentation(db, event.resourceId);
      case "checkout":
        return checkoutRepresentation(db, event.resourceId);
      case "discount":
        return discountRepresentation(db, event.resourceId);
      case "review":
        return reviewRepresentation(db, event.resourceId);
      case "gift_card":
        return giftCardRepresentation(db, event.resourceId);
      case "transaction": {
        const giftCardId = factString(event, "giftCardId");
        return giftCardId ? transactionRepresentation(db, event.resourceId, giftCardId) : null;
      }
      case "object": {
        const objectType = factString(event, "objectType");
        return objectType ? objectRepresentation(db, objectType, event.resourceId) : null;
      }
    }
  };
}
