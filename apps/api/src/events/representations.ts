// The `data` of a webhook delivery (COMMERCE-HOOKS H5): each resource type's
// sealed representation (`EVENT_REPRESENTATION_SCHEMAS`, @scalius/shared/events),
// read here with a few indexed queries and built only through
// `buildEventRepresentation`, so nothing the schema does not declare can leave
// the store. It is resolved in full; the delivery then reads the protected
// fields its subscription did not opt in to as null. A resource that no
// longer exists is null.

import { readAbandonedCheckoutRepresentations, type CheckoutRecoveryRuntime } from "@scalius/core/modules/checkout";
import type { Database } from "@scalius/database/client";
import { inJsonArray } from "@scalius/core/utils/in-json-array";
import {
  customerMarketingConsents,
  customerTagLinks,
  customers,
  deliveryShipments,
  giftCardTransactions,
  giftCards,
  inventoryLevels,
  inventoryTransferLines,
  inventoryTransfers,
  orderDiscountAllocations,
  orderEvents,
  orderFulfillmentLines,
  orderFulfillments,
  orderItems,
  orderPayments,
  orderRefundLines,
  orderRefunds,
  orderReturnLines,
  orderReturns,
  orders,
  productOptionDefinitions,
  productOptionValues,
  productReviews,
  productVariantOptionValues,
  productVariants,
  products,
  purchaseOrderLines,
  purchaseOrders,
  refundAttempts,
} from "@scalius/database/schema";
import { and, asc, desc, eq, getTableColumns, inArray, isNull, sql } from "drizzle-orm";
import { getObjectEventRepresentation } from "@scalius/core/modules/objects";
import { isGiftCardExpired } from "@scalius/core/modules/gift-cards";
import { readPayoutRepresentation } from "@scalius/core/modules/payouts";
import { readConversationRepresentation } from "@scalius/core/modules/conversations";
import { readStoreCurrency } from "@scalius/core/modules/markets";
import { loadProductMediaProjections, parsePublishedChannelIds, productVariantBarcodeIdentityIn, publishedChannelIdsSql, resolveProductImageRepresentation } from "@scalius/core/modules/products";
import { getBarcodeIdentityKey } from "@scalius/shared/barcode-identity";
import type { OutboxEvent, WebhookRepresentationResolver } from "@scalius/core/modules/events";
import {
  buildEventRepresentation,
  type EventRepresentation,
  type EventRepresentationInput,
  type EventRepresentationType,
} from "@scalius/shared/events";
import { allProtectedData } from "@scalius/shared/plugins/protected-data";
import { readDiscountRepresentations } from "./discount-representations";
import { isLineInputEntry, LINE_ADJUSTMENT_PROPERTY_KEY, readLinePurchaseOptions, readOrderLineProperties } from "@scalius/shared/line-properties";
import { appScopedKeyAppId } from "@scalius/shared/plugins/ids";
import { readCheckoutAttributes } from "@scalius/shared/plugins/buyer-ui";
import { resolveOrderAppFacts, type OrderAppFactRow } from "@scalius/core/modules/order-kernel";
import { qualifiedColumn } from "@scalius/core/utils/qualified-column";
import { POINT_OF_SALE_TENDER_VIAS } from "@scalius/shared/payment-terms";

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

/**
 * A stored state column read as its sealed enum. The sealed parse in `sealed`
 * refuses a value outside the enum (a bug, never a guess); the stored lists
 * mirror the sealed ones (`packages/database/__tests__/resource-states.test.ts`).
 */
function storedState<T extends EventRepresentationType, K extends keyof EventRepresentationInput<T>>(_type: T, _field: K, value: string): EventRepresentationInput<T>[K] {
  return value as EventRepresentationInput<T>[K];
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

/** Each id's rows of `children` (already in their order), at most `MAX_LINES` per id. */
function groupBy<T>(children: readonly T[], key: (child: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const child of children) {
    const list = grouped.get(key(child)) ?? [];
    if (list.length < MAX_LINES) list.push(child);
    grouped.set(key(child), list);
  }
  return grouped;
}

/** The found ids' values, in the order the ids were asked for. */
function inIdOrder<T>(ids: readonly string[], byId: ReadonlyMap<string, T>): T[] {
  return ids.flatMap((id) => {
    const value = byId.get(id);
    return value === undefined ? [] : [value];
  });
}

/**
 * The orders' sealed representations, in the order of `ids` (missing ones
 * left out): one round trip of two statements, whatever the count (the API's
 * lists read through here too). The orders statement also carries each
 * order's immutable discount facts (its store discount allocations and its
 * `app_discount` facts) as JSON from correlated subqueries on their order
 * indexes, so discount applications add no statement.
 */
export async function readOrderRepresentations(db: Database, ids: readonly string[]): Promise<EventRepresentation<"order">[]> {
  if (ids.length === 0) return [];
  const orderId = qualifiedColumn(orders.id);
  const [rows, lineRows] = await db.batch([
    db.select({
      ...getTableColumns(orders),
      // `order_discount_allocations_order_idx`: one entry per discount effect and line.
      discountAllocationsJson: sql<string>`(SELECT coalesce(json_group_array(json_object(
        'id', ${orderDiscountAllocations.id}, 'createdAt', ${orderDiscountAllocations.createdAt},
        'orderItemId', ${orderDiscountAllocations.orderItemId}, 'promotionId', ${orderDiscountAllocations.promotionId},
        'title', ${orderDiscountAllocations.promotionName}, 'code', ${orderDiscountAllocations.promotionCode},
        'method', ${orderDiscountAllocations.method}, 'target', ${orderDiscountAllocations.target},
        'amountMinor', ${orderDiscountAllocations.discountAmountMinor})), '[]')
        FROM ${orderDiscountAllocations} WHERE ${orderDiscountAllocations.orderId} = ${orderId})`,
      // The app discounts the order committed with (`order_events`, kind `app_discount`).
      appDiscountFactsJson: sql<string>`(SELECT coalesce(json_group_array(json_object(
        'id', ${orderEvents.id}, 'createdAt', ${orderEvents.createdAt}, 'data', ${orderEvents.data})), '[]')
        FROM ${orderEvents} WHERE ${orderEvents.orderId} = ${orderId} AND ${orderEvents.kind} = 'app_discount')`,
      // An in-person sale's receipt facts (`pos_sale`, written with the order): only a `pos` order has one.
      pointOfSaleJson: sql<string | null>`(SELECT ${orderEvents.data} FROM ${orderEvents}
        WHERE ${orderEvents.orderId} = ${orderId} AND ${orderEvents.kind} = 'pos_sale' ORDER BY ${orderEvents.createdAt}, ${orderEvents.id} LIMIT 1)`,
    }).from(orders).where(inArray(orders.id, [...ids])),
    db.select({
      orderId: orderItems.orderId,
      id: orderItems.id,
      productId: orderItems.productId,
      variantId: orderItems.variantId,
      title: orderItems.productName,
      variantLabel: orderItems.variantLabel,
      // The code it was sold under (0179); older lines read the SKU's current code, in the same read.
      sku: sql<string | null>`coalesce(${orderItems.sku}, (SELECT ${productVariants.sku} FROM ${productVariants} WHERE ${productVariants.id} = ${qualifiedColumn(orderItems.variantId)}))`,
      quantity: orderItems.quantity,
      fulfilledQuantity: orderItems.fulfilledQuantity,
      unitPriceMinor: orderItems.unitPriceMinor,
      subtotalMinor: orderItems.lineSubtotalMinor,
      discountMinor: orderItems.discountAmountMinor,
      taxMinor: orderItems.taxAmountMinor,
      // The line's frozen inputs, in the same read: its add-ons and purchase options ride there.
      properties: orderItems.properties,
    }).from(orderItems).where(inArray(orderItems.orderId, [...ids]))
      .orderBy(asc(orderItems.orderId), asc(orderItems.createdAt), asc(orderItems.id)),
  ]);
  const lines = groupBy(lineRows, (line) => line.orderId);
  return inIdOrder(ids, new Map(rows.map(({ discountAllocationsJson, appDiscountFactsJson, pointOfSaleJson, ...order }) => [
    order.id,
    orderFrom(order, lines.get(order.id) ?? [], orderDiscountApplications(order.id, discountAllocationsJson, appDiscountFactsJson), pointOfSaleFacts(pointOfSaleJson)),
  ])));
}

type PointOfSaleFacts = NonNullable<EventRepresentationInput<"order">["pointOfSale"]>;
const TENDER_VIAS: readonly string[] = POINT_OF_SALE_TENDER_VIAS;

/** A sale's receipt facts as its `pos_sale` fact recorded them; null for any other order (or a malformed fact). */
function pointOfSaleFacts(json: string | null): PointOfSaleFacts | null {
  if (!json) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const facts = value as Record<string, unknown>;
  const minor = (input: unknown): input is number => typeof input === "number" && Number.isSafeInteger(input) && input >= 0;
  if (typeof facts.locationId !== "string" || !minor(facts.tenderedMinor) || !minor(facts.changeMinor) || !Array.isArray(facts.tenders)) return null;
  const tenders: PointOfSaleFacts["tenders"] = [];
  for (const tender of facts.tenders as unknown[]) {
    const row = tender as Record<string, unknown> | null;
    if (!row || typeof row.via !== "string" || !TENDER_VIAS.includes(row.via) || !minor(row.amountMinor)) return null;
    tenders.push({
      via: row.via as PointOfSaleFacts["tenders"][number]["via"],
      amountMinor: row.amountMinor,
      reference: typeof row.reference === "string" ? row.reference : null,
    });
  }
  return {
    locationId: facts.locationId,
    staffMemberId: typeof facts.staffMemberId === "string" ? facts.staffMemberId : null,
    tenders,
    tenderedMinor: facts.tenderedMinor,
    changeMinor: facts.changeMinor,
  };
}

type DiscountApplication = EventRepresentationInput<"order">["discountApplications"][number];

type DiscountAllocationFact = { id: string; createdAt: number; orderItemId: string | null; promotionId: string; title: string; code: string | null; method: "automatic" | "code"; target: string; amountMinor: number };

/** A JSON array column of facts, in commit order (`createdAt`, then id); `[]` for a malformed value. */
function factList<T extends { id: string; createdAt: number }>(json: string | null): T[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return (parsed as T[]).filter((fact) => fact && typeof fact.id === "string")
    .sort((left, right) => Number(left.createdAt) - Number(right.createdAt) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/**
 * One order's discount applications: its store discounts (one per discount
 * and code, lines in allocation order) then its apps' (in the order they
 * applied), from the immutable facts the order committed with.
 */
function orderDiscountApplications(orderId: string, allocationsJson: string | null, appFactsJson: string | null): DiscountApplication[] {
  const applications = new Map<string, DiscountApplication>();
  for (const row of factList<DiscountAllocationFact>(allocationsJson)) {
    const key = `${row.promotionId}\u0000${row.code ?? ""}`;
    const application = applications.get(key) ?? {
      source: "store" as const,
      discountId: row.promotionId,
      appId: null,
      title: row.title,
      code: row.code ?? null,
      method: row.method,
      amountMinor: 0,
      shippingAmountMinor: 0,
      lines: [],
    };
    applications.set(key, application);
    const amountMinor = Number(row.amountMinor);
    if (row.target === "shipping" || !row.orderItemId) {
      application.shippingAmountMinor += amountMinor;
    } else {
      application.amountMinor += amountMinor;
      const line = application.lines.find((entry) => entry.orderItemId === row.orderItemId);
      if (line) line.amountMinor += amountMinor;
      else if (application.lines.length < MAX_LINES) application.lines.push({ orderItemId: row.orderItemId, amountMinor });
    }
  }
  const appRows: OrderAppFactRow[] = factList<{ id: string; createdAt: number; data: string | null }>(appFactsJson)
    .map((fact) => ({ orderId, kind: "app_discount", data: fact.data, createdAt: Number(fact.createdAt) }));
  const apps = resolveOrderAppFacts(appRows).discounts.map((fact): DiscountApplication => ({
    source: "app",
    discountId: null,
    appId: fact.pluginId,
    title: fact.title,
    code: fact.code,
    method: fact.code ? "code" : "automatic",
    amountMinor: fact.amountMinor,
    shippingAmountMinor: fact.shippingAmountMinor,
    lines: fact.lines.slice(0, MAX_LINES),
  }));
  return [...applications.values(), ...apps];
}

/** A line's frozen entries as the representation lists them: what the buyer entered, the apps' add-ons, its purchase options. */
function orderLineEntries(properties: string | null) {
  const entries = readOrderLineProperties(properties);
  return {
    properties: entries.filter((entry) => isLineInputEntry(entry.key)).map((entry) => ({
      key: entry.key,
      label: entry.label,
      value: entry.value,
      displayValue: entry.displayValue,
      priceMinor: entry.priceMinor,
      appId: entry.appId ?? appScopedKeyAppId(entry.key),
    })),
    adjustments: entries.filter((entry) => entry.key === LINE_ADJUSTMENT_PROPERTY_KEY).map((entry) => ({
      appId: entry.appId ?? null,
      title: entry.displayValue,
      amountMinor: entry.priceMinor,
    })),
    purchaseOptions: readLinePurchaseOptions(entries),
  };
}

async function orderRepresentation(db: Database, orderId: string) {
  return (await readOrderRepresentations(db, [orderId]))[0] ?? null;
}

type OrderLineRow = {
  orderId: string;
  id: string;
  productId: string;
  variantId: string | null;
  title: string | null;
  variantLabel: string | null;
  sku: string | null;
  quantity: number;
  fulfilledQuantity: number | null;
  unitPriceMinor: number | null;
  subtotalMinor: number | null;
  discountMinor: number | null;
  taxMinor: number | null;
  properties: string | null;
};

function orderFrom(
  order: OrderRow,
  lines: readonly OrderLineRow[],
  discountApplications: readonly DiscountApplication[],
  pointOfSale: PointOfSaleFacts | null = null,
) {
  return sealed("order", {
    id: order.id,
    orderNumber: order.orderNumber ?? null,
    status: storedState("order", "status", order.status),
    paymentStatus: storedState("order", "paymentStatus", order.paymentStatus),
    fulfillmentStatus: storedState("order", "fulfillmentStatus", order.fulfillmentStatus),
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
    paymentTerms: order.paymentTermsDays !== null && order.paymentDueAt
      ? { kind: "net" as const, days: order.paymentTermsDays, dueAt: isoRequired(order.paymentDueAt) }
      : null,
    customerId: order.customerId ?? null,
    accountCustomerId: order.accountOwnerCustomerId ?? null,
    contact: { name: order.customerName ?? null, email: order.customerEmail ?? null, phone: order.customerPhone ?? null },
    requiresShipping: Boolean(order.requiresShipping),
    shippingMethodId: order.shippingMethodId ?? null,
    shippingAddress: order.requiresShipping ? shippingAddress(order) : null,
    billingAddress: billingAddress(order),
    fulfillmentLocationId: order.fulfillmentLocationId ?? null,
    revision: order.version,
    lines: lines.map(({ orderId: _orderId, properties, ...line }) => {
      const entries = orderLineEntries(properties);
      return {
      ...line,
      ...entries,
      unitPriceMinor: line.unitPriceMinor ?? 0,
      subtotalMinor: line.subtotalMinor ?? 0,
      discountMinor: line.discountMinor ?? 0,
      taxMinor: line.taxMinor ?? 0,
      fulfilledQuantity: line.fulfilledQuantity ?? 0,
      };
    }),
    attributes: readCheckoutAttributes(order.attributes),
    discountApplications: [...discountApplications],
    pointOfSale,
    createdAt: isoRequired(order.createdAt),
    updatedAt: isoRequired(order.updatedAt),
    deletedAt: iso(order.deletedAt),
  });
}

/**
 * Returns (one by id, or an order's, oldest first) with their lines: two
 * reads, whichever the count (the API's per-order list and its single read).
 */
async function readReturnRepresentations(db: Database, where: { id: string } | { orderId: string }) {
  const rows = await db.select().from(orderReturns)
    .where("id" in where ? eq(orderReturns.id, where.id) : eq(orderReturns.orderId, where.orderId))
    .orderBy(asc(orderReturns.createdAt), asc(orderReturns.id)).limit(MAX_LINES).all();
  if (rows.length === 0) return [];
  const lineRows = await db.select().from(orderReturnLines)
    .where(inJsonArray(orderReturnLines.returnId, rows.map((row) => row.id)))
    .orderBy(asc(orderReturnLines.returnId), asc(orderReturnLines.createdAt), asc(orderReturnLines.id)).all();
  const linesByReturn = groupBy(lineRows, (line) => line.returnId);
  return rows.map((row) => returnFrom(row, linesByReturn.get(row.id) ?? []));
}

/** An order's returns, oldest first (the API's per-order list). */
export function readOrderReturnRepresentations(db: Database, orderId: string) {
  return readReturnRepresentations(db, { orderId });
}

/** One return as webhooks carry it (ReturnResource), or null. */
export async function readReturnRepresentation(db: Database, returnId: string) {
  return (await readReturnRepresentations(db, { id: returnId }))[0] ?? null;
}

/** An app's actor id on a return it requested (`app:<plugin id>`, routes/admin/orders-returns.ts). */
const APP_ACTOR_PREFIX = "app:";

function returnFrom(row: typeof orderReturns.$inferSelect, lines: readonly (typeof orderReturnLines.$inferSelect)[]) {
  return sealed("return", {
    id: row.id,
    orderId: row.orderId,
    status: row.status,
    reason: row.reason,
    source: row.source,
    appId: row.source === "app" && row.actorId?.startsWith(APP_ACTOR_PREFIX) ? row.actorId.slice(APP_ACTOR_PREFIX.length) : null,
    revision: row.version,
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
      untrackedQuantity: line.untrackedQuantity,
      rejectedQuantity: line.rejectedQuantity,
    })),
    createdAt: isoRequired(row.createdAt),
    updatedAt: isoRequired(row.updatedAt),
  });
}

/**
 * The products' sealed representations, in the order of `ids`: the products,
 * their live SKUs with their option values, their options, the store currency
 * and their galleries. The four catalogue reads go in one batch, so a whole
 * page costs three D1 calls (the batch, the currency and the galleries, at
 * most 90 products per gallery read).
 */
export async function readProductRepresentations(db: Database, ids: readonly string[]): Promise<EventRepresentation<"product">[]> {
  if (ids.length === 0) return [];
  const productIds = [...new Set(ids)];
  const productsRead = db.select({
    id: products.id,
    name: products.name,
    slug: products.slug,
    isActive: products.isActive,
    brandId: products.brandId,
    categoryId: products.categoryId,
    aggregateRevision: products.aggregateRevision,
    isGiftCard: products.isGiftCard,
    priceMinor: products.priceMinor,
    description: products.description,
    productCondition: products.productCondition,
    metaTitle: products.metaTitle,
    metaDescription: products.metaDescription,
    salesChannelIds: publishedChannelIdsSql(sql.raw('"products"."id"')),
    createdAt: products.createdAt,
    updatedAt: products.updatedAt,
    deletedAt: products.deletedAt,
  }).from(products).where(inArray(products.id, productIds));
  const variantsRead = db.select({
    productId: productVariants.productId,
    id: productVariants.id,
    sku: productVariants.sku,
    priceMinor: productVariants.priceMinor,
    barcode: productVariants.barcode,
    barcodeType: productVariants.barcodeType,
    weight: productVariants.weight,
    imageId: productVariants.imageId,
    trackInventory: productVariants.trackInventory,
    fulfillmentKind: productVariants.fulfillmentKind,
    isDefault: productVariants.isDefault,
  }).from(productVariants)
    .where(and(inArray(productVariants.productId, productIds), isNull(productVariants.deletedAt)))
    .orderBy(asc(productVariants.productId), asc(productVariants.createdAt), asc(productVariants.id));
  // Live options and their live values, in the merchant's order.
  const optionsRead = db.select({
    productId: productOptionDefinitions.productId,
    optionId: productOptionDefinitions.id,
    name: productOptionDefinitions.name,
    standardMapping: productOptionDefinitions.standardMapping,
    value: productOptionValues.value,
  }).from(productOptionDefinitions)
    .innerJoin(productOptionValues, and(eq(productOptionValues.optionDefinitionId, productOptionDefinitions.id), isNull(productOptionValues.deletedAt)))
    .where(and(inArray(productOptionDefinitions.productId, productIds), isNull(productOptionDefinitions.deletedAt)))
    .orderBy(asc(productOptionDefinitions.productId), asc(productOptionDefinitions.position), asc(productOptionValues.position), asc(productOptionValues.id));
  // Each live SKU's value of each live option.
  const selectionsRead = db.select({
    variantId: productVariantOptionValues.variantId,
    name: productOptionDefinitions.name,
    value: productOptionValues.value,
  }).from(productVariantOptionValues)
    .innerJoin(productVariants, eq(productVariants.id, productVariantOptionValues.variantId))
    .innerJoin(productOptionDefinitions, eq(productOptionDefinitions.id, productVariantOptionValues.optionDefinitionId))
    .innerJoin(productOptionValues, eq(productOptionValues.id, productVariantOptionValues.optionValueId))
    .where(and(
      inArray(productVariants.productId, productIds),
      isNull(productVariants.deletedAt),
      isNull(productOptionDefinitions.deletedAt),
    ))
    .orderBy(asc(productVariantOptionValues.variantId), asc(productOptionDefinitions.position));
  const [[rows, variantRows, optionRows, selectionRows], currency, mediaByProduct] = await Promise.all([
    db.batch([productsRead, variantsRead, optionsRead, selectionsRead]),
    readStoreCurrency(db),
    loadProductMediaProjections(db, productIds),
  ]);
  const variants = groupBy(variantRows, (variant) => variant.productId);
  const optionValues = new Map<string, Record<string, string>>();
  for (const selection of selectionRows) {
    const values = optionValues.get(selection.variantId) ?? {};
    values[selection.name] = selection.value;
    optionValues.set(selection.variantId, values);
  }
  const options = new Map<string, { id: string; name: string; standardMapping: string; values: string[] }[]>();
  for (const row of optionRows) {
    const list = options.get(row.productId) ?? [];
    let option = list.at(-1);
    if (option?.id !== row.optionId) {
      option = { id: row.optionId, name: row.name, standardMapping: row.standardMapping, values: [] };
      list.push(option);
      options.set(row.productId, list);
    }
    option.values.push(row.value);
  }
  return inIdOrder(ids, new Map(rows.map((product) => {
    const gallery = mediaByProduct.get(product.id) ?? [];
    const mediaIdByAssociation = new Map(gallery.map((item) => [item.id, item.mediaId]));
    return [product.id, sealed("product", {
      id: product.id,
      name: product.name,
      slug: product.slug,
      status: product.deletedAt ? "trashed" : product.isActive ? "active" : "draft",
      brandId: product.brandId ?? null,
      categoryId: product.categoryId ?? null,
      revision: product.aggregateRevision,
      isGiftCard: Boolean(product.isGiftCard),
      imageUrl: resolveProductImageRepresentation(gallery)?.url ?? null,
      currency: currency.code,
      priceMinor: product.priceMinor,
      variants: (variants.get(product.id) ?? []).map(({ productId: _productId, weight, imageId, ...variant }) => ({
        ...variant,
        barcode: variant.barcode ?? null,
        barcodeType: variant.barcodeType ?? null,
        weightGrams: weight ?? null,
        optionValues: optionValues.get(variant.id) ?? {},
        mediaId: imageId ? mediaIdByAssociation.get(imageId) ?? null : null,
      })),
      createdAt: isoRequired(product.createdAt),
      updatedAt: isoRequired(product.updatedAt),
      deletedAt: iso(product.deletedAt),
      description: product.description ?? null,
      condition: product.productCondition ?? null,
      metaTitle: product.metaTitle ?? null,
      metaDescription: product.metaDescription ?? null,
      salesChannelIds: parsePublishedChannelIds(product.salesChannelIds),
      media: [...gallery].sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((item) => ({
        id: item.id,
        mediaId: item.mediaId,
        kind: item.kind,
        url: item.url,
        altText: item.contextualAltText ?? null,
        featured: item.isPrimary,
      })),
      options: options.get(product.id) ?? [],
    })];
  })));
}

async function productRepresentation(db: Database, productId: string) {
  return (await readProductRepresentations(db, [productId]))[0] ?? null;
}

type VariantWhere = { ids: readonly string[] } | { skus: readonly string[] } | { barcodes: readonly string[] };

/** The keys a lookup matches on: ids as given, SKU and barcode codes by their identity (`lower(trim(...))`). */
function variantKeys(where: VariantWhere): string[] {
  if ("ids" in where) return [...where.ids];
  if ("skus" in where) return where.skus.map((sku) => sku.trim().toLowerCase());
  return where.barcodes.flatMap((barcode) => getBarcodeIdentityKey(barcode) ?? []);
}

/**
 * The two reads of SKUs' sealed representations (the SKUs and their levels),
 * for a caller's batch: `readVariantRepresentations` sends them alone, and a
 * stock write appends them to its commit batch (`InventoryReadAfter`).
 */
export function variantRepresentationReads(db: Database, where: VariantWhere) {
  const keys = variantKeys(where);
  const matches = "ids" in where
    ? inArray(productVariants.id, keys)
    : "skus" in where
      ? inArray(sql`lower(trim(${productVariants.sku}))`, keys)
      : productVariantBarcodeIdentityIn(keys);
  const variantsRead = db.select({
    id: productVariants.id,
    productId: productVariants.productId,
    sku: productVariants.sku,
    trackInventory: productVariants.trackInventory,
    stock: productVariants.stock,
    stockVersion: productVariants.stockVersion,
    updatedAt: productVariants.updatedAt,
    barcode: productVariants.barcode,
    deletedAt: productVariants.deletedAt,
  }).from(productVariants).where(matches);
  const levelsRead = db.select({ variantId: inventoryLevels.variantId, locationId: inventoryLevels.locationId, onHand: inventoryLevels.onHand })
    .from(inventoryLevels).innerJoin(productVariants, eq(productVariants.id, inventoryLevels.variantId)).where(matches)
    .orderBy(asc(inventoryLevels.variantId), asc(inventoryLevels.locationId));
  type VariantRow = Awaited<typeof variantsRead>[number];
  type LevelRow = Awaited<typeof levelsRead>[number];
  return {
    statements: [variantsRead, levelsRead] as const,
    /** The representations, in the order of the keys, from the two reads' rows. */
    assemble(results: readonly unknown[]) {
      const rows = (results[0] ?? []) as VariantRow[];
      const levelRows = (results[1] ?? []) as LevelRow[];
      if (rows.length === 0) return [];
      const levels = groupBy(levelRows, (level) => level.variantId);
      const keyOf = (variant: VariantRow) => "ids" in where ? variant.id : "skus" in where ? variant.sku.trim().toLowerCase() : getBarcodeIdentityKey(variant.barcode) ?? "";
      const byKey = new Map(rows.map((variant) => [keyOf(variant), sealed("variant", {
        id: variant.id,
        productId: variant.productId,
        sku: variant.sku,
        trackInventory: variant.trackInventory,
        onHand: variant.stock,
        stockVersion: variant.stockVersion,
        levels: (levels.get(variant.id) ?? []).map(({ variantId: _variantId, ...level }) => level),
        updatedAt: isoRequired(variant.updatedAt),
        barcode: variant.barcode ?? null,
        retiredAt: iso(variant.deletedAt),
      })]));
      return inIdOrder([...new Set(keys)], byKey);
    },
  };
}

/**
 * SKUs' sealed representations (their stock in total and per location), by
 * id, SKU code or barcode (`lower(trim(...))`, the identity indexes), retired
 * ones too: two reads in one batch (one D1 call) for at most 90 SKUs.
 */
export async function readVariantRepresentations(db: Database, where: VariantWhere) {
  if (variantKeys(where).length === 0) return [];
  const reads = variantRepresentationReads(db, where);
  return reads.assemble(await db.batch([reads.statements[0], reads.statements[1]]));
}

export async function readVariantRepresentation(db: Database, variantId: string) {
  return (await readVariantRepresentations(db, { ids: [variantId] }))[0] ?? null;
}

/**
 * The customers' sealed representations, in the order of `ids`: the
 * customers, their consents and their tags, three reads for a whole page.
 */
export async function readCustomerRepresentations(db: Database, ids: readonly string[]): Promise<EventRepresentation<"customer">[]> {
  if (ids.length === 0) return [];
  const [rows, consentRows, tagRows] = await Promise.all([
    db.select().from(customers).where(inArray(customers.id, [...ids])).all(),
    db.select({
      customerId: customerMarketingConsents.customerId,
      channel: customerMarketingConsents.channel,
      state: customerMarketingConsents.state,
      contact: customerMarketingConsents.contact,
      updatedAt: customerMarketingConsents.updatedAt,
    }).from(customerMarketingConsents).where(inArray(customerMarketingConsents.customerId, [...ids]))
      .orderBy(asc(customerMarketingConsents.customerId), asc(customerMarketingConsents.channel)).all(),
    db.select({ customerId: customerTagLinks.customerId, tag: customerTagLinks.tag })
      .from(customerTagLinks).where(inArray(customerTagLinks.customerId, [...ids]))
      .orderBy(asc(customerTagLinks.customerId), asc(customerTagLinks.tag)).all(),
  ]);
  const consents = groupBy(consentRows, (consent) => consent.customerId);
  const tags = groupBy(tagRows, (tag) => tag.customerId);
  return inIdOrder(ids, new Map(rows.map((customer) => [customer.id, sealed("customer", {
    id: customer.id,
    name: customer.name ?? null,
    email: customer.email ?? null,
    phone: (customer.phone as string | null) ?? null,
    hasAccount: customer.accountClaimedAt !== null && customer.accountClaimedAt !== undefined,
    totalOrders: customer.totalOrders,
    lastOrderAt: iso(customer.lastOrderAt),
    mergedIntoCustomerId: customer.mergedIntoCustomerId ?? null,
    tags: (tags.get(customer.id) ?? []).map((link) => link.tag),
    consents: (consents.get(customer.id) ?? []).map(({ customerId: _customerId, ...consent }) => ({
      ...consent,
      contact: consent.contact || null,
      updatedAt: isoRequired(consent.updatedAt),
    })),
    taxExempt: customer.taxExempt === true,
    taxExemptionId: customer.taxExempt === true ? customer.taxExemptionId ?? null : null,
    createdAt: isoRequired(customer.createdAt),
    updatedAt: isoRequired(customer.updatedAt),
    deletedAt: iso(customer.deletedAt),
    erasedAt: iso(customer.erasedAt),
  })])));
}

async function customerRepresentation(db: Database, customerId: string) {
  return (await readCustomerRepresentations(db, [customerId]))[0] ?? null;
}

/** A stock document read per batch: at most this many ids per wave (D1's statement limits). */
const STOCK_DOCUMENT_WAVE = 90;

function idWaves(ids: readonly string[]): string[][] {
  const unique = [...new Set(ids)];
  const waves: string[][] = [];
  for (let start = 0; start < unique.length; start += STOCK_DOCUMENT_WAVE) waves.push(unique.slice(start, start + STOCK_DOCUMENT_WAVE));
  return waves;
}

/**
 * Purchase orders' sealed representations, in the order of `ids` (missing
 * ones left out): the headers and their lines, two reads in one batch per
 * wave of 90 ids, each id list bound as one value.
 */
export async function readPurchaseOrderRepresentations(db: Database, ids: readonly string[]): Promise<EventRepresentation<"purchase_order">[]> {
  const byId = new Map<string, EventRepresentation<"purchase_order">>();
  for (const wave of idWaves(ids)) {
    const [headers, lineRows] = await db.batch([
      db.select().from(purchaseOrders).where(inJsonArray(purchaseOrders.id, wave)),
      db.select({
        purchaseOrderId: purchaseOrderLines.purchaseOrderId,
        id: purchaseOrderLines.id,
        variantId: purchaseOrderLines.variantId,
        quantity: purchaseOrderLines.quantity,
        receivedQuantity: purchaseOrderLines.receivedQuantity,
        unitCostMinor: purchaseOrderLines.unitCostMinor,
      }).from(purchaseOrderLines).where(inJsonArray(purchaseOrderLines.purchaseOrderId, wave))
        .orderBy(asc(purchaseOrderLines.purchaseOrderId), asc(purchaseOrderLines.position), asc(purchaseOrderLines.id)),
    ]);
    const lines = groupBy(lineRows, (line) => line.purchaseOrderId);
    for (const order of headers) {
      byId.set(order.id, sealed("purchase_order", {
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
        lines: (lines.get(order.id) ?? []).map(({ purchaseOrderId: _purchaseOrderId, ...line }) => line),
        orderedAt: iso(order.orderedAt),
        receivedAt: iso(order.receivedAt),
        cancelledAt: iso(order.cancelledAt),
        createdAt: isoRequired(order.createdAt),
        updatedAt: isoRequired(order.updatedAt),
      }));
    }
  }
  return inIdOrder([...new Set(ids)], byId);
}

async function purchaseOrderRepresentation(db: Database, purchaseOrderId: string) {
  return (await readPurchaseOrderRepresentations(db, [purchaseOrderId]))[0] ?? null;
}

/**
 * Transfers' sealed representations, in the order of `ids` (missing ones
 * left out): two reads in one batch per wave of 90 ids.
 */
export async function readInventoryTransferRepresentations(db: Database, ids: readonly string[]): Promise<EventRepresentation<"inventory_transfer">[]> {
  const byId = new Map<string, EventRepresentation<"inventory_transfer">>();
  for (const wave of idWaves(ids)) {
    const [headers, lineRows] = await db.batch([
      db.select().from(inventoryTransfers).where(inJsonArray(inventoryTransfers.id, wave)),
      db.select({
        transferId: inventoryTransferLines.transferId,
        id: inventoryTransferLines.id,
        variantId: inventoryTransferLines.variantId,
        quantity: inventoryTransferLines.quantity,
        shippedQuantity: inventoryTransferLines.shippedQuantity,
        receivedQuantity: inventoryTransferLines.receivedQuantity,
        returnedQuantity: inventoryTransferLines.returnedQuantity,
      }).from(inventoryTransferLines).where(inJsonArray(inventoryTransferLines.transferId, wave))
        .orderBy(asc(inventoryTransferLines.transferId), asc(inventoryTransferLines.position), asc(inventoryTransferLines.id)),
    ]);
    const lines = groupBy(lineRows, (line) => line.transferId);
    for (const transfer of headers) {
      byId.set(transfer.id, sealed("inventory_transfer", {
        id: transfer.id,
        number: transfer.number,
        status: transfer.status,
        originLocationId: transfer.originLocationId,
        destinationLocationId: transfer.destinationLocationId,
        reference: transfer.reference ?? null,
        expectedOn: transfer.expectedOn ?? null,
        revision: transfer.revision,
        lines: (lines.get(transfer.id) ?? []).map(({ transferId: _transferId, ...line }) => line),
        shippedAt: iso(transfer.shippedAt),
        receivedAt: iso(transfer.receivedAt),
        cancelledAt: iso(transfer.cancelledAt),
        createdAt: isoRequired(transfer.createdAt),
        updatedAt: isoRequired(transfer.updatedAt),
      }));
    }
  }
  return inIdOrder([...new Set(ids)], byId);
}

async function transferRepresentation(db: Database, transferId: string) {
  return (await readInventoryTransferRepresentations(db, [transferId]))[0] ?? null;
}

const fulfillmentColumns = {
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
};

/** Fulfilments (one by id, or an order's, oldest first) with their lines: two reads. */
async function readFulfillmentRepresentations(db: Database, where: { id: string } | { orderId: string }) {
  const rows = await db.select(fulfillmentColumns).from(orderFulfillments).innerJoin(orders, eq(orders.id, orderFulfillments.orderId))
    .where("id" in where ? eq(orderFulfillments.id, where.id) : eq(orderFulfillments.orderId, where.orderId))
    .orderBy(asc(orderFulfillments.createdAt), asc(orderFulfillments.id)).limit(MAX_LINES).all();
  if (rows.length === 0) return [];
  const lineRows = await db.select({
    fulfillmentId: orderFulfillmentLines.fulfillmentId,
    id: orderFulfillmentLines.id,
    orderItemId: orderFulfillmentLines.orderItemId,
    quantity: orderFulfillmentLines.quantity,
  }).from(orderFulfillmentLines).where(inJsonArray(orderFulfillmentLines.fulfillmentId, rows.map((row) => row.id)))
    .orderBy(asc(orderFulfillmentLines.fulfillmentId), asc(orderFulfillmentLines.id)).all();
  const lines = groupBy(lineRows, (line) => line.fulfillmentId);
  return rows.map((row) => sealed("fulfillment", {
    ...row,
    shipmentId: row.shipmentId ?? null,
    locationId: row.locationId ?? null,
    cashCollectedMinor: row.cashCollectedMinor ?? null,
    lines: (lines.get(row.id) ?? []).map(({ fulfillmentId: _fulfillmentId, ...line }) => line),
    createdAt: isoRequired(row.createdAt),
    voidedAt: iso(row.voidedAt),
  }));
}

/** An order's fulfilments, oldest first (the API's per-order list). */
export function readOrderFulfillmentRepresentations(db: Database, orderId: string) {
  return readFulfillmentRepresentations(db, { orderId });
}

/** One fulfilment as webhooks carry it (FulfillmentResource), or null. */
export async function readFulfillmentRepresentation(db: Database, fulfillmentId: string) {
  return (await readFulfillmentRepresentations(db, { id: fulfillmentId }))[0] ?? null;
}

const shipmentColumns = {
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
};

/** Shipments (one by id, or an order's, oldest first): one read. */
async function readShipmentRepresentations(db: Database, where: { id: string } | { orderId: string }) {
  const rows = await db.select(shipmentColumns).from(deliveryShipments).innerJoin(orders, eq(orders.id, deliveryShipments.orderId))
    .where("id" in where ? eq(deliveryShipments.id, where.id) : eq(deliveryShipments.orderId, where.orderId))
    .orderBy(asc(deliveryShipments.createdAt), asc(deliveryShipments.id)).limit(MAX_LINES).all();
  return rows.map(({ lastChecked, ...fields }) => sealed("shipment", {
    ...fields,
    status: storedState("shipment", "status", fields.status),
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
  }));
}

/** An order's shipments, oldest first (the API's per-order list). */
export function readOrderShipmentRepresentations(db: Database, orderId: string) {
  return readShipmentRepresentations(db, { orderId });
}

export async function readShipmentRepresentation(db: Database, shipmentId: string) {
  return (await readShipmentRepresentations(db, { id: shipmentId }))[0] ?? null;
}

/** Payments (one by id, or an order's, oldest first): one read. */
async function readPaymentRepresentations(db: Database, where: { id: string } | { orderId: string }) {
  const rows = await db.select().from(orderPayments)
    .where("id" in where ? eq(orderPayments.id, where.id) : eq(orderPayments.orderId, where.orderId))
    .orderBy(asc(orderPayments.createdAt), asc(orderPayments.id)).limit(MAX_LINES).all();
  return rows.map((row) => sealed("payment", {
    id: row.id,
    orderId: row.orderId,
    status: storedState("payment", "status", row.status),
    method: row.paymentMethod,
    type: storedState("payment", "type", row.paymentType),
    currency: row.currency,
    amountMinor: row.amountMinor,
    settlementCurrency: row.settlementCurrency,
    settlementAmountMinor: row.settlementAmountMinor,
    providerRef: row.providerRef ?? null,
    createdAt: isoRequired(row.createdAt),
    updatedAt: isoRequired(row.updatedAt),
  }));
}

/** An order's payments and refunds, oldest first (the API's per-order list). */
export function readOrderPaymentRepresentations(db: Database, orderId: string) {
  return readPaymentRepresentations(db, { orderId });
}

async function paymentRepresentation(db: Database, paymentId: string) {
  return (await readPaymentRepresentations(db, { id: paymentId }))[0] ?? null;
}

/** One payment as webhooks carry it (PaymentResource), or null. */
export const readPaymentRepresentation = paymentRepresentation;

/** Refunds (one by id, or an order's, oldest first) with their lines and payments: three reads in one batch. */
async function readRefundRepresentations(db: Database, where: { id: string } | { orderId: string }) {
  const scope = "id" in where ? eq(orderRefunds.id, where.id) : eq(orderRefunds.orderId, where.orderId);
  const [rows, lineRows, paymentRows] = await db.batch([
    db.select().from(orderRefunds).where(scope).orderBy(asc(orderRefunds.createdAt), asc(orderRefunds.id)).limit(MAX_LINES),
    db.select({
      refundId: orderRefundLines.refundId,
      orderItemId: orderRefundLines.orderItemId,
      variantId: orderItems.variantId,
      quantity: orderRefundLines.quantity,
    }).from(orderRefundLines)
      .innerJoin(orderRefunds, eq(orderRefunds.id, orderRefundLines.refundId))
      .leftJoin(orderItems, eq(orderItems.id, orderRefundLines.orderItemId))
      .where(scope)
      .orderBy(asc(orderRefundLines.refundId), asc(orderRefundLines.orderItemId)),
    db.select({ refundId: refundAttempts.refundGroupId, paymentId: refundAttempts.refundPaymentId })
      .from(refundAttempts)
      .innerJoin(orderRefunds, eq(orderRefunds.id, refundAttempts.refundGroupId))
      .where(scope)
      .orderBy(asc(refundAttempts.refundGroupId), asc(refundAttempts.allocationIndex)),
  ]);
  const lines = groupBy(lineRows, (line) => line.refundId);
  const payments = groupBy(paymentRows, (payment) => payment.refundId);
  return rows.map((row) => sealed("refund", {
    id: row.id,
    orderId: row.orderId,
    status: row.status,
    currency: row.currency,
    amountMinor: row.amountMinor,
    settlement: row.settlement,
    lines: (lines.get(row.id) ?? []).slice(0, MAX_LINES).map(({ refundId: _refundId, ...line }) => ({ ...line, variantId: line.variantId ?? null })),
    paymentIds: (payments.get(row.id) ?? []).map((payment) => payment.paymentId),
    createdAt: isoRequired(row.createdAt),
    updatedAt: isoRequired(row.updatedAt),
  }));
}

/** An order's refunds, oldest first (the API's per-order list). */
export function readOrderRefundRepresentations(db: Database, orderId: string) {
  return readRefundRepresentations(db, { orderId });
}

/** One refund as webhooks carry it (RefundResource), or null. */
export async function readRefundRepresentation(db: Database, refundId: string) {
  return (await readRefundRepresentations(db, { id: refundId }))[0] ?? null;
}
/** The one checkout builder: the batched reader `abandoned_checkouts.list` pages through too. */
async function checkoutRepresentation(db: Database, abandonedCheckoutId: string, runtime?: CheckoutRecoveryRuntime) {
  return (await readAbandonedCheckoutRepresentations(db, [abandonedCheckoutId], runtime))[0] ?? null;
}

/** The one discount builder: the batched reader `discounts.list` pages through too. */
async function discountRepresentation(db: Database, promotionId: string) {
  return (await readDiscountRepresentations(db, [promotionId]))[0] ?? null;
}

/** Reviews one read takes: a page of `reviews.list` (bound as one JSON value). */
export const REVIEW_REPRESENTATIONS_MAX = 90;

/** These reviews as their webhooks carry them, in the order asked; unknown ids are left out. */
export async function readReviewRepresentations(db: Database, ids: readonly string[]): Promise<EventRepresentation<"review">[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  if (unique.length > REVIEW_REPRESENTATIONS_MAX) throw new RangeError(`Read at most ${REVIEW_REPRESENTATIONS_MAX} reviews at once.`);
  const rows = await db.select().from(productReviews).where(inJsonArray(productReviews.id, unique)).all();
  const byId = new Map(rows.map((review) => [review.id, sealed("review", {
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
    revision: review.version,
    createdAt: isoRequired(review.createdAt),
    updatedAt: isoRequired(review.updatedAt),
    orderItemId: review.orderItemId ?? null,
    verified: review.orderItemId !== null,
    appId: review.appId ?? null,
    moderationReason: review.moderationReason ?? null,
  })]));
  return unique.flatMap((id) => byId.get(id) ?? []);
}

async function reviewRepresentation(db: Database, reviewId: string) {
  return (await readReviewRepresentations(db, [reviewId]))[0] ?? null;
}

/** The newest ledger entries a gift card read lists (`transactions`), newest first. */
export const GIFT_CARD_TRANSACTIONS_LISTED = 200;

/** Gift cards by id, in the order asked (a missing one is left out); at most a list page (50). */
export async function readGiftCardRepresentations(db: Database, ids: readonly string[]): Promise<EventRepresentation<"gift_card">[]> {
  if (ids.length === 0) return [];
  const cards = await db.select().from(giftCards).where(inJsonArray(giftCards.id, ids)).all();
  const byId = new Map(cards.map((card) => [card.id, card]));
  return ids.flatMap((id) => {
    const card = byId.get(id);
    return card ? [sealed("gift_card", {
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
      message: card.message ?? null,
      note: card.note ?? null,
      expiresAt: iso(card.expiresAt),
      expired: isGiftCardExpired(card),
      revision: card.version,
      createdAt: isoRequired(card.createdAt),
      updatedAt: isoRequired(card.updatedAt),
    })] : [];
  });
}

const giftCardRepresentation = async (db: Database, giftCardId: string) => (await readGiftCardRepresentations(db, [giftCardId]))[0] ?? null;

const giftCardTransactionColumns = {
  id: giftCardTransactions.id,
  giftCardId: giftCardTransactions.giftCardId,
  kind: giftCardTransactions.kind,
  amountMinor: giftCardTransactions.amountMinor,
  balanceAfterMinor: giftCardTransactions.balanceAfterMinor,
  orderId: giftCardTransactions.orderId,
  actorType: giftCardTransactions.actorType,
  reason: giftCardTransactions.reason,
  createdAt: giftCardTransactions.createdAt,
  currency: giftCards.currencyCode,
};

/** Ledger entries with their card's currency. */
const giftCardTransactionRows = (db: Database) => db.select(giftCardTransactionColumns)
  .from(giftCardTransactions).innerJoin(giftCards, eq(giftCards.id, giftCardTransactions.giftCardId));
type GiftCardTransactionRow = Awaited<ReturnType<ReturnType<typeof giftCardTransactionRows>["all"]>>[number];

function giftCardTransactionOf(row: GiftCardTransactionRow) {
  return sealed("gift_card_transaction", { ...row, orderId: row.orderId ?? null, reason: row.reason ?? null, createdAt: isoRequired(row.createdAt) });
}

async function giftCardTransactionRepresentation(db: Database, transactionId: string, giftCardId: string) {
  const row = await giftCardTransactionRows(db)
    .where(and(eq(giftCardTransactions.id, transactionId), eq(giftCardTransactions.giftCardId, giftCardId))).get();
  return row ? giftCardTransactionOf(row) : null;
}

/**
 * What `gift_cards.get` answers: the card's representation (a `gift_card`
 * delivery's `data`) and its newest ledger entries, each a
 * `gift_card_transaction` delivery's `data`. Null when there is no such card.
 */
export async function readGiftCardRepresentation(db: Database, giftCardId: string) {
  const [giftCard, rows] = await Promise.all([
    giftCardRepresentation(db, giftCardId),
    giftCardTransactionRows(db)
      .where(eq(giftCardTransactions.giftCardId, giftCardId))
      .orderBy(desc(giftCardTransactions.createdAt), desc(giftCardTransactions.id))
      .limit(GIFT_CARD_TRANSACTIONS_LISTED)
      .all(),
  ]);
  return giftCard ? { giftCard, transactions: rows.map(giftCardTransactionOf) } : null;
}

/** An object record as `objects.get` answers it and an object delivery carries it, or null. */
export async function readObjectRepresentation(db: Database, objectType: string, objectId: string): Promise<EventRepresentation<"object"> | null> {
  const record = await getObjectEventRepresentation(db, objectType, objectId).catch(() => null);
  return record ? sealed("object", record) : null;
}

const factString = (event: OutboxEvent, key: string): string | null => {
  const value = (event.facts as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
};

/**
 * Each event's sealed representation, in full; the delivery applies its
 * subscription's customer data. One resolver serves one drain: an event's
 * representation is read once for all its endpoints (a failed read is not kept).
 */
export function createWebhookRepresentationResolver(db: Database, runtime?: CheckoutRecoveryRuntime): WebhookRepresentationResolver {
  const read = representationReader(db, runtime);
  const known = new Map<string, Promise<EventRepresentation | null>>();
  return (event: OutboxEvent) => {
    const key = `${event.id} ${event.resourceType} ${event.resourceId}`;
    const cached = known.get(key);
    if (cached) return cached;
    const pending = read(event);
    known.set(key, pending);
    pending.catch(() => known.delete(key));
    return pending;
  };
}

function representationReader(db: Database, runtime?: CheckoutRecoveryRuntime): WebhookRepresentationResolver {
  return async (event: OutboxEvent): Promise<EventRepresentation | null> => {
    switch (event.resourceType) {
      case "order":
        return orderRepresentation(db, event.resourceId);
      case "return":
        return readReturnRepresentation(db, event.resourceId);
      case "product":
        return productRepresentation(db, event.resourceId);
      case "variant":
        return readVariantRepresentation(db, event.resourceId);
      case "customer":
        return customerRepresentation(db, event.resourceId);
      case "purchase_order":
        return purchaseOrderRepresentation(db, event.resourceId);
      case "inventory_transfer":
        return transferRepresentation(db, event.resourceId);
      case "fulfillment":
        return readFulfillmentRepresentation(db, event.resourceId);
      case "refund":
        return readRefundRepresentation(db, event.resourceId);
      case "shipment":
        return readShipmentRepresentation(db, event.resourceId);
      case "payment":
        return paymentRepresentation(db, event.resourceId);
      case "checkout":
        return checkoutRepresentation(db, event.resourceId, runtime);
      case "discount":
        return discountRepresentation(db, event.resourceId);
      case "review":
        return reviewRepresentation(db, event.resourceId);
      case "gift_card":
        return giftCardRepresentation(db, event.resourceId);
      case "gift_card_transaction": {
        const giftCardId = factString(event, "giftCardId");
        return giftCardId ? giftCardTransactionRepresentation(db, event.resourceId, giftCardId) : null;
      }
      case "object": {
        const objectType = factString(event, "objectType");
        return objectType ? readObjectRepresentation(db, objectType, event.resourceId) : null;
      }
      case "payout":
        return readPayoutRepresentation(db, event.resourceId);
      case "conversation":
        return readConversationRepresentation(db, event.resourceId);
    }
  };
}
