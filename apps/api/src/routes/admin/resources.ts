// The stable app API's resources (operation-registry/README.md), mounted at
// /admin/resources: resource-shaped reads that return exactly the sealed
// representation a webhook delivery carries (`EVENT_REPRESENTATION_SCHEMAS`,
// built only in events/representations.ts), and the writes an app makes on
// orders, in integer minor units. Lists page by cursor in (updatedAt, id)
// order and stop early before a page passes the response budget, so a sync
// walks every change once without offsets or counts.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { MAX_LINE_QUANTITY, MAX_ORDER_LINES } from "@scalius/shared/order-limits";
import type { Context, MiddlewareHandler } from "hono";
import { and, asc, eq, gte, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { customerTagLinks, customers, orders, productVariants, products } from "@scalius/database/schema";
import { EVENT_REPRESENTATION_SCHEMAS } from "@scalius/shared/events";
import { MANUAL_FULFILLMENT_TYPES } from "@scalius/shared/fulfilment";
import { encodeListCursorOrNull, type ListCursorShape } from "@scalius/shared/pagination";
import { fromMinor } from "@scalius/shared/money";
import { keysetCondition, keysetOrderBy, readListCursor, type KeysetOrder } from "@scalius/core/utils/keyset";
import { NotFoundError, ValidationError } from "../../utils/api-error";
import { createOrderSchema, manualOrderPaymentMethodSchema, overdueOrderCondition, recordOrderEvent } from "@scalius/core/modules/orders";
import { recordOrderPayment } from "@scalius/core/modules/payments";
import { paymentTermsSchema, RECORDED_PAYMENT_VIAS } from "@scalius/shared/payment-terms";
import { placeManualOrder } from "./orders/create";
import { created, ok } from "../../utils/api-response";
import { errorResponses, conflictResponse, namedSharedSchema, serviceUnavailableResponse, successEnvelope } from "../../schemas/responses";
import {
  readCustomerRepresentations,
  readOrderFulfillmentRepresentations,
  readOrderPaymentRepresentations,
  readOrderRepresentations,
  readOrderShipmentRepresentations,
  readPaymentRepresentation,
  readProductRepresentations,
  readShipmentRepresentation,
  readVariantRepresentation,
  readVariantRepresentations,
} from "../../events/representations";
import {
  createPriceList,
  deletePriceList,
  getPriceList,
  listPriceLists,
  listPriceListVariants,
  PRICE_LIST_WRITE_MAX_VARIANTS,
  setPriceListPrices,
  updatePriceList,
  type PriceListRecord,
} from "@scalius/core/modules/price-lists";
import { readStoreCurrency } from "@scalius/core/modules/markets";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { MAX_PRICE_LIST_QUANTITY_BREAKS, PRICE_LIST_MIN_QUANTITY_MAX } from "@scalius/shared/market-pricing";
import { createPriceListSchema, scheduleInstant, updatePriceListSchema } from "../../schemas/price-lists";
import { assertContactFilterAllowed } from "./contact-access";
import { handOverOrderLines } from "./orders/fulfilments";
import { bookOrderShipment, createShipmentBodySchema } from "./orders-status";
import { idempotencyKeyHeaderSchema, scopedRequestKey } from "./idempotency";

const app = new OpenAPIHono<{ Bindings: Env }>();

const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Cache-Control", "private, no-store");
};
app.use("*", noStore);

const OrderResource = namedSharedSchema(EVENT_REPRESENTATION_SCHEMAS.order, "OrderResource");
const ProductResource = namedSharedSchema(EVENT_REPRESENTATION_SCHEMAS.product, "ProductResource");
const VariantResource = namedSharedSchema(EVENT_REPRESENTATION_SCHEMAS.variant, "VariantResource");
const CustomerResource = namedSharedSchema(EVENT_REPRESENTATION_SCHEMAS.customer, "CustomerResource");
const FulfillmentResource = namedSharedSchema(EVENT_REPRESENTATION_SCHEMAS.fulfillment, "FulfillmentResource");
const ShipmentResource = namedSharedSchema(EVENT_REPRESENTATION_SCHEMAS.shipment, "ShipmentResource");
const PaymentResource = namedSharedSchema(EVENT_REPRESENTATION_SCHEMAS.payment, "PaymentResource");

/** A page stops before its JSON passes this, so a list always fits an app or agent result (64 KiB). */
const PAGE_BYTE_BUDGET = 56 * 1024;
const DEFAULT_PAGE = 20;
const MAX_PAGE = 50;

const idParam = z.object({ id: z.string().min(1).max(128) });
const readResponses = { 400: errorResponses[400], 401: errorResponses[401], 403: errorResponses[403], 404: errorResponses[404], 429: errorResponses[429], 500: errorResponses[500] };

const pageQuery = {
  cursor: z.string().max(1024).optional().openapi({ description: "The `nextCursor` of the page before; leave it out for the first page." }),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(DEFAULT_PAGE)
    .openapi({ description: "At most this many records; a page may hold fewer to stay within the response budget." }),
  updatedSince: z.string().datetime({ offset: true }).optional()
    .openapi({ description: "Only records updated at or after this ISO 8601 time: keep the last `updatedAt` you saw to resume a sync." }),
};

const nextCursorSchema = z.string().nullable().openapi({ description: "Pass it as `cursor` for the next page; null on the last page." });

function seconds(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

const UPDATED_ORDER = (column: KeysetOrder["column"], id: KeysetOrder["id"]): KeysetOrder => ({ column, id, direction: "asc" });
const CURSOR_SHAPE: ListCursorShape = { sort: "updatedAt", direction: "asc", kinds: ["number"] };

/**
 * One page of a resource list: the page's ids in (updatedAt, id) order, then
 * their representations in one batched read, cut before the response budget.
 */
async function resourcePage<T extends { id: string; updatedAt: string }>(
  options: {
    order: KeysetOrder;
    cursor: string | undefined;
    limit: number;
    where: SQL[];
    ids: (where: SQL | undefined, limit: number) => Promise<{ id: string }[]>;
    load: (ids: string[]) => Promise<T[]>;
  },
): Promise<{ items: T[]; nextCursor: string | null }> {
  const where = [...options.where];
  if (options.cursor) where.push(keysetCondition(options.order, readListCursor(options.cursor, CURSOR_SHAPE)));
  const rows = await options.ids(where.length > 0 ? and(...where) : undefined, options.limit + 1);
  const more = rows.length > options.limit;
  const items = await options.load(rows.slice(0, options.limit).map((row) => row.id));
  const kept: T[] = [];
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const item of items) {
    const size = encoder.encode(JSON.stringify(item)).byteLength + 1;
    if (kept.length > 0 && bytes + size > PAGE_BYTE_BUDGET) break;
    kept.push(item);
    bytes += size;
  }
  const last = kept.at(-1);
  const cut = more || kept.length < items.length;
  return {
    items: kept,
    nextCursor: cut && last
      ? encodeListCursorOrNull({ sort: CURSOR_SHAPE.sort, direction: "asc", values: [seconds(last.updatedAt)], id: last.id })
      : null,
  };
}

// ─── Orders ──────────────────────────────────────────────────────────────────

const ordersQuery = z.object({
  ...pageQuery,
  status: z.string().min(1).max(64).optional(),
  paymentStatus: z.string().min(1).max(64).optional(),
  fulfillmentStatus: z.string().min(1).max(64).optional(),
  customerId: z.string().min(1).max(128).optional(),
  orderNumber: z.coerce.number().int().positive().optional(),
  email: z.string().trim().email().max(254).optional()
    .openapi({ description: "The buyer's email, matched whole. Needs read_customer_emails." }),
  phone: z.string().trim().regex(/^\+[1-9]\d{6,14}$/u, "Use the E.164 number, such as +8801712345678.").optional()
    .openapi({ description: "The buyer's phone in E.164, matched whole. Needs read_customer_phones." }),
  trashed: z.enum(["true", "false"]).optional().openapi({ description: "true lists trashed orders instead." }),
  overdue: z.enum(["true"]).optional().openapi({
    description: "true lists only overdue invoices: deferred (net terms) orders whose `paymentTerms.dueAt` has passed with money still due.",
  }),
});

app.openapi(createRoute({
  operationId: "dashboard.resources.orders.list",
  method: "get",
  path: "/orders",
  tags: ["App API - Orders"],
  summary: "List orders, least recently updated first",
  description: "Orders as webhooks carry them (OrderResource), in (updatedAt, id) order. Start a sync with updatedSince and follow nextCursor. Contact filters need the matching read_customer_* scope.",
  request: { query: ordersQuery },
  responses: {
    200: { description: "A page of orders", content: { "application/json": { schema: successEnvelope(z.object({ orders: z.array(OrderResource), nextCursor: nextCursorSchema })) } } },
    ...readResponses,
  },
}), async (c) => {
  const query = c.req.valid("query");
  if (query.email) assertContactFilterAllowed(c, "email", "email");
  if (query.phone) assertContactFilterAllowed(c, "phone", "phone");
  const db = c.get("db");
  const where: SQL[] = [query.trashed === "true" ? isNotNull(orders.deletedAt) : isNull(orders.deletedAt)];
  if (query.updatedSince) where.push(gte(sql`${orders.updatedAt}`, seconds(query.updatedSince)));
  if (query.status) where.push(eq(orders.status, query.status as typeof orders.$inferSelect.status));
  if (query.paymentStatus) where.push(eq(orders.paymentStatus, query.paymentStatus as typeof orders.$inferSelect.paymentStatus));
  if (query.fulfillmentStatus) where.push(eq(orders.fulfillmentStatus, query.fulfillmentStatus as typeof orders.$inferSelect.fulfillmentStatus));
  if (query.customerId) where.push(eq(orders.customerId, query.customerId));
  if (query.orderNumber) where.push(eq(orders.orderNumber, query.orderNumber));
  if (query.email) where.push(sql`lower(trim(${orders.customerEmail})) = ${query.email.toLowerCase()}`);
  if (query.phone) where.push(eq(orders.customerPhone, query.phone));
  if (query.overdue === "true") where.push(overdueOrderCondition());
  const order = UPDATED_ORDER(orders.updatedAt, orders.id);
  const page = await resourcePage({
    order,
    cursor: query.cursor,
    limit: query.limit,
    where,
    ids: (condition, limit) => db.select({ id: orders.id }).from(orders).where(condition).orderBy(...keysetOrderBy(order)).limit(limit).all(),
    load: (ids) => readOrderRepresentations(db, ids),
  });
  return ok(c, { orders: page.items, nextCursor: page.nextCursor });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.orders.get",
  method: "get",
  path: "/orders/{id}",
  tags: ["App API - Orders"],
  summary: "Get an order",
  description: "The order as webhooks carry it: totals and lines in integer minor units of `currency`.",
  request: { params: idParam },
  responses: {
    200: { description: "The order", content: { "application/json": { schema: successEnvelope(OrderResource) } } },
    ...readResponses,
  },
}), async (c) => {
  const [order] = await readOrderRepresentations(c.get("db"), [c.req.valid("param").id]);
  if (!order) throw new NotFoundError("Order not found");
  return ok(c, order);
});

// ─── Placing an order ────────────────────────────────────────────────────────

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

/** A postal address in the canonical fields (AGENTS.md address rules); Bangladesh may add its delivery place ids. */
const addressInputSchema = z.object({
  countryCode: z.string().trim().length(2).openapi({ description: "ISO 3166-1 alpha-2." }),
  company: optionalText(100),
  line1: z.string().trim().min(1).max(500),
  line2: optionalText(200),
  dependentLocality: optionalText(120),
  locality: optionalText(120),
  adminArea: optionalText(120),
  postalCode: optionalText(20),
  placeIds: z.object({
    city: z.string().trim().min(1).max(180).nullable().optional(),
    zone: z.string().trim().min(1).max(180).nullable().optional(),
    area: z.string().trim().min(1).max(180).nullable().optional(),
  }).strict().optional().openapi({ description: "The store's delivery place ids (Bangladesh's City, Thana, Area), where its delivery zones use them." }),
}).strict();

const orderCreateBody = z.object({
  customerId: z.string().trim().min(1).max(128).optional().openapi({
    description: "File the order under this customer: its name, phone and email become the order's contact, so the app needs no contact scope. Send this or contact.",
  }),
  contact: z.object({
    name: z.string().trim().min(3).max(100),
    email: z.string().trim().email().max(254).nullable().optional(),
    phone: z.string().trim().min(7).max(16).nullable().optional().openapi({ description: "Required for a cash-on-delivery order." }),
  }).strict().optional(),
  items: z.array(z.object({
    productId: z.string().min(1).max(180),
    variantId: z.string().min(1).max(180),
    quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
    unitPriceMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().openapi({
      description: "A unit price set by hand (a quote, an agreed renewal price), in minor units of the store currency at its price increment; it replaces the catalogue price and the order's timeline records it.",
    }),
    properties: z.array(z.object({ key: z.string().min(1).max(40), value: z.string().max(1000) })).max(20).optional(),
  }).strict()).min(1).max(MAX_ORDER_LINES),
  shippingMethodId: z.string().trim().min(1).max(180).nullable().optional().openapi({ description: "The delivery or pickup method; a physical line needs one with an address, or a pickup method." }),
  shippingAddress: addressInputSchema.nullable().optional().openapi({ description: "Where it ships; none for pickup, digital and service orders." }),
  billingAddress: addressInputSchema.extend({ name: optionalText(100), line1: z.string().trim().max(500).nullable().optional() })
    .nullable().optional().openapi({ description: "Omit or null when the shipping address bills." }),
  shippingMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).openapi({ description: "The delivery charge, in minor units of the store currency." }),
  discountMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().openapi({ description: "An order discount set by hand, in minor units of the store currency." }),
  paymentMethod: manualOrderPaymentMethodSchema.default("cod").openapi({
    description: "How the buyer pays: `cod` (cash on delivery) or `net_terms` (an invoice paid later by its due date: the order is placed unpaid, its stock reserved, and its payments are recorded with dashboard.resources.payments.create).",
  }),
  paymentTerms: paymentTermsSchema.optional().openapi({
    description: "An invoice's terms, `{ kind: \"net\", days }` (1 to 365): the order is due that many days after it is placed. Only with `net_terms`; omitted, the store's net days (Settings → Payments).",
  }),
  attributes: z.record(z.string().max(120), z.string().max(500)).optional().openapi({ description: "Checkout attributes the store's apps declare (`<app id>.<key>`); unknown keys are dropped." }),
  notes: optionalText(500),
  channelSource: z.string().trim().max(64).nullable().optional().openapi({ description: "Where it came in; an app's order defaults to the app's id." }),
  salesChannelId: z.string().trim().min(1).max(160).nullable().optional(),
}).strict().refine((value) => Boolean(value.customerId) !== Boolean(value.contact), {
  message: "Send customerId or contact, not both.",
  path: ["customerId"],
}).refine((value) => !value.paymentTerms || value.paymentMethod === "net_terms", {
  message: "paymentTerms goes with paymentMethod net_terms.",
  path: ["paymentTerms"],
});

/** A UUID the order-create attempt table takes, derived from the caller's Idempotency-Key (random without one). */
async function orderRequestKey(c: Context, key: string | undefined): Promise<string> {
  if (!key) return crypto.randomUUID();
  const hex = (await scopedRequestKey(c, "dashboard.resources.orders.create", key)).slice(4, 36);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

app.openapi(createRoute({
  operationId: "dashboard.resources.orders.create",
  method: "post",
  path: "/orders",
  tags: ["App API - Orders"],
  summary: "Place an order for a customer",
  description: "Places a confirmed order the way staff do, with the store's apps' checkout functions applied: stock is reserved, tax and app discounts are priced, and the order is attributed to the app (channel `app`) or to staff. Amounts are minor units of the store currency. Send an Idempotency-Key: a repeat returns the first order.",
  request: {
    headers: idempotencyKeyHeaderSchema,
    body: { required: true, content: { "application/json": { schema: orderCreateBody } } },
  },
  responses: {
    201: { description: "The order", content: { "application/json": { schema: successEnvelope(z.object({ order: OrderResource })) } } },
    ...errorResponses,
    409: conflictResponse,
    503: serviceUnavailableResponse,
  },
}), async (c) => {
  const body = c.req.valid("json");
  const db = c.get("db");
  const appPrincipal = c.get("pluginPrincipal");
  const customer = body.customerId
    ? await db.select({ name: customers.name, email: customers.email, phone: customers.phone })
      .from(customers).where(and(eq(customers.id, body.customerId), isNull(customers.deletedAt))).get()
    : null;
  if (body.customerId && !customer) throw new NotFoundError("Customer not found");
  const contact = customer
    ? { name: customer.name, email: customer.email ?? null, phone: (customer.phone as string | null) || null }
    : { name: body.contact!.name, email: body.contact!.email ?? null, phone: body.contact!.phone ?? null };
  if (!contact.phone) {
    throw new ValidationError(body.paymentMethod === "net_terms"
      ? "An invoice order needs the buyer's phone."
      : "A cash-on-delivery order needs the buyer's phone.", { issues: [{ field: body.customerId ? "customerId" : "contact.phone", code: "phone_required" }] });
  }
  const places = getDecimalPlaces((await readStoreCurrency(db)).code);
  const ship = body.shippingAddress ?? null;
  const bill = body.billingAddress ?? null;
  const parsed = createOrderSchema.safeParse({
    requestKey: await orderRequestKey(c, c.req.valid("header")["idempotency-key"]),
    customerId: body.customerId ?? null,
    customerName: contact.name,
    customerPhone: contact.phone,
    customerEmail: contact.email,
    shippingCountryCode: ship?.countryCode ?? null,
    shippingAddress: ship?.line1 ?? null,
    shippingAddressLine2: ship?.line2 ?? null,
    shippingDependentLocality: ship?.dependentLocality ?? null,
    shippingLocality: ship?.locality ?? null,
    shippingAdminArea: ship?.adminArea ?? null,
    shippingPostalCode: ship?.postalCode ?? null,
    shippingCompany: ship?.company ?? null,
    city: ship?.placeIds?.city ?? null,
    zone: ship?.placeIds?.zone ?? null,
    area: ship?.placeIds?.area ?? null,
    billingSameAsShipping: bill ? false : null,
    ...(bill ? {
      billingCountryCode: bill.countryCode,
      billingName: bill.name ?? null,
      billingCompany: bill.company ?? null,
      billingAddress: bill.line1 ?? null,
      billingAddressLine2: bill.line2 ?? null,
      billingDependentLocality: bill.dependentLocality ?? null,
      billingLocality: bill.locality ?? null,
      billingAdminArea: bill.adminArea ?? null,
      billingPostalCode: bill.postalCode ?? null,
    } : {}),
    notes: body.notes ?? null,
    // The manual-order core takes the editor's major units; the conversion is exact for every safe minor amount.
    discountAmount: body.discountMinor === undefined ? null : fromMinor(body.discountMinor, places),
    shippingCharge: fromMinor(body.shippingMinor, places),
    items: body.items.map((item) => ({
      productId: item.productId,
      variantId: item.variantId,
      quantity: item.quantity,
      ...(item.properties ? { properties: item.properties } : {}),
      ...(item.unitPriceMinor !== undefined ? { unitPriceMinor: item.unitPriceMinor } : {}),
    })),
    shippingMethodId: body.shippingMethodId ?? null,
    channelSource: body.channelSource ?? (appPrincipal ? appPrincipal.pluginId.replace(/[^a-z0-9]+/gu, "_") : null),
    salesChannelId: body.salesChannelId ?? null,
    ...(body.attributes ? { attributes: body.attributes } : {}),
    channel: appPrincipal ? "app" : "admin",
    paymentMethod: body.paymentMethod,
    ...(body.paymentTerms ? { paymentTermsDays: body.paymentTerms.days } : {}),
  });
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? "Check the order.", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) });
  }
  const { response } = await placeManualOrder(c, parsed.data);
  const [order] = await readOrderRepresentations(db, [response.id]);
  if (!order) throw new NotFoundError("Order not found");
  return created(c, { order });
});

const recordPaymentHeaders = z.object({
  "idempotency-key": idempotencyKeyHeaderSchema.shape["idempotency-key"].unwrap().openapi({
    description: "Required: one key records one payment; a repeat returns the first result.",
  }),
});

const recordPaymentBody = z.object({
  amountMinor: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).openapi({
    description: "What was received, in minor units of the order's `currency`; at most its `balanceDueMinor`.",
  }),
  via: z.enum(RECORDED_PAYMENT_VIAS).openapi({ description: "How it was received." }),
  reference: z.string().trim().max(120).nullable().optional().openapi({ description: "The bank, cheque or transfer reference." }),
  note: z.string().trim().max(500).nullable().optional(),
  expectedVersion: z.number().int().min(1).optional().openapi({ description: "The order `version` you read; a different one is refused with 409." }),
}).strict();

app.openapi(createRoute({
  operationId: "dashboard.resources.payments.create",
  method: "post",
  path: "/orders/{id}/payments",
  tags: ["App API - Orders"],
  summary: "Record a payment against an invoice order",
  description: "Records money received for a deferred (net terms) order: a bank transfer, cheque or cash against its invoice. No provider is called. The order's paid amount and payment status advance in the same write, `payment.updated` (and `order.paid` once nothing is due) follow, and a refund of it is a manual settlement. Send an Idempotency-Key: a repeat returns the first payment.",
  request: {
    params: idParam,
    headers: recordPaymentHeaders,
    body: { required: true, content: { "application/json": { schema: recordPaymentBody } } },
  },
  responses: {
    201: { description: "The recorded payment", content: { "application/json": { schema: successEnvelope(z.object({ payment: PaymentResource })) } } },
    ...errorResponses,
    409: conflictResponse,
  },
}), async (c) => {
  const db = c.get("db");
  const orderId = c.req.valid("param").id;
  const body = c.req.valid("json");
  const appPrincipal = c.get("pluginPrincipal");
  const user = c.get("user") as { id?: string } | undefined;
  const recordedBy = appPrincipal ? `app:${appPrincipal.pluginId}` : `staff:${user?.id ?? "unknown"}`;
  const result = await recordOrderPayment(db, {
    orderId,
    amountMinor: body.amountMinor,
    via: body.via,
    reference: body.reference ?? null,
    note: body.note ?? null,
    recordedBy,
    requestKey: await scopedRequestKey(c, "dashboard.resources.payments.create", c.req.valid("header")["idempotency-key"]),
    ...(body.expectedVersion !== undefined ? { expectedVersion: body.expectedVersion } : {}),
  });
  if (!result.replayed) {
    await recordOrderEvent(db, {
      orderId,
      kind: "payment_recorded",
      actorId: user?.id ?? null,
      data: { amountMinor: body.amountMinor, via: body.via, reference: body.reference ?? null, ...(appPrincipal ? { appId: appPrincipal.pluginId } : {}) },
    });
  }
  const payment = await readPaymentRepresentation(db, result.paymentId);
  if (!payment) throw new NotFoundError("Payment not found");
  return created(c, { payment });
});

async function requireOrderCurrency(c: Context, orderId: string): Promise<string> {
  const row = await c.get("db").select({ currency: orders.currencyCode }).from(orders).where(eq(orders.id, orderId)).get();
  if (!row) throw new NotFoundError("Order not found");
  return row.currency;
}

app.openapi(createRoute({
  operationId: "dashboard.resources.payments.list",
  method: "get",
  path: "/orders/{id}/payments",
  tags: ["App API - Orders"],
  summary: "List an order's payments and refunds",
  description: "Every payment and refund of the order, oldest first, in integer minor units of `currency` (and of `settlementCurrency` as settled).",
  request: { params: idParam },
  responses: {
    200: { description: "The payments", content: { "application/json": { schema: successEnvelope(z.object({ payments: z.array(PaymentResource) })) } } },
    ...readResponses,
  },
}), async (c) => {
  const orderId = c.req.valid("param").id;
  await requireOrderCurrency(c, orderId);
  return ok(c, { payments: await readOrderPaymentRepresentations(c.get("db"), orderId) });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.fulfillments.list",
  method: "get",
  path: "/orders/{id}/fulfillments",
  tags: ["App API - Orders"],
  summary: "List an order's fulfilments",
  description: "Every hand-over of the order (sent, picked up, performed, voided), oldest first, with its lines.",
  request: { params: idParam },
  responses: {
    200: { description: "The fulfilments", content: { "application/json": { schema: successEnvelope(z.object({ fulfillments: z.array(FulfillmentResource) })) } } },
    ...readResponses,
  },
}), async (c) => {
  const orderId = c.req.valid("param").id;
  await requireOrderCurrency(c, orderId);
  return ok(c, { fulfillments: await readOrderFulfillmentRepresentations(c.get("db"), orderId) });
});

const minorAmount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const fulfillmentCreateBody = z.object({
  kind: z.enum(MANUAL_FULFILLMENT_TYPES).openapi({
    description: "`ship`: sent with your own rider or carrier. `pickup`: the buyer collected it. `service`: the service was performed.",
  }),
  lines: z.array(z.object({
    orderItemId: z.string().min(1).max(180),
    quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
  })).min(1).max(MAX_ORDER_LINES).optional().openapi({ description: "Which units to hand over; part of a line is fine. Omit for every unit of this kind not handed over yet." }),
  tracking: z.object({
    courierName: z.string().trim().max(120).optional(),
    trackingId: z.string().trim().max(180).optional(),
    trackingUrl: z.string().trim().url().optional(),
    note: z.string().trim().max(500).optional(),
    amountMinor: minorAmount.optional().openapi({ description: "What the delivery cost, in minor units of the order's currency." }),
  }).strict().optional().openapi({ description: "Parcel details; only for `ship`." }),
  cashReceivedMinor: minorAmount.optional().openapi({
    description: "Cash on delivery taken in the same action (`pickup`/`service`), in minor units of the order's currency. Must equal the balance due.",
  }),
}).strict();

app.openapi(createRoute({
  operationId: "dashboard.resources.fulfillments.create",
  method: "post",
  path: "/orders/{id}/fulfillments",
  tags: ["App API - Orders"],
  summary: "Hand over order lines",
  description: "Marks units sent, picked up or performed. A repeat with the same Idempotency-Key returns the first fulfilment and acts once. The last ship line makes the order shipped; the last pickup or service line, with the money settled, makes it delivered.",
  request: {
    params: idParam,
    headers: idempotencyKeyHeaderSchema,
    body: { required: true, content: { "application/json": { schema: fulfillmentCreateBody } } },
  },
  responses: {
    201: { description: "The fulfilment and the order after it", content: { "application/json": { schema: successEnvelope(z.object({ fulfillment: FulfillmentResource, order: OrderResource })) } } },
    ...errorResponses,
    409: conflictResponse,
    503: serviceUnavailableResponse,
  },
}), async (c) => {
  const orderId = c.req.valid("param").id;
  const body = c.req.valid("json");
  const exponent = getDecimalPlaces(await requireOrderCurrency(c, orderId));
  const result = await handOverOrderLines(c, orderId, {
    requestKey: await scopedRequestKey(c, "dashboard.resources.fulfillments.create", c.req.valid("header")["idempotency-key"]),
    kind: body.kind,
    lines: body.lines?.map((line) => ({ itemId: line.orderItemId, quantity: line.quantity })),
    tracking: body.tracking && {
      courierName: body.tracking.courierName,
      trackingId: body.tracking.trackingId,
      trackingUrl: body.tracking.trackingUrl,
      note: body.tracking.note,
      shipmentAmount: body.tracking.amountMinor === undefined ? undefined : fromMinor(body.tracking.amountMinor, exponent),
    },
    cashReceived: body.cashReceivedMinor === undefined ? undefined : fromMinor(body.cashReceivedMinor, exponent),
  });
  const db = c.get("db");
  const [fulfillments, [order]] = await Promise.all([
    readOrderFulfillmentRepresentations(db, orderId),
    readOrderRepresentations(db, [orderId]),
  ]);
  const fulfillment = fulfillments.find((candidate) => candidate.id === result.fulfillmentId);
  if (!fulfillment || !order) throw new NotFoundError("Fulfilment not found");
  return created(c, { fulfillment, order });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.shipments.list",
  method: "get",
  path: "/orders/{id}/shipments",
  tags: ["App API - Orders"],
  summary: "List an order's shipments",
  description: "Every courier or own-rider parcel of the order, oldest first, with its tracking and cost in minor units of `currency`.",
  request: { params: idParam },
  responses: {
    200: { description: "The shipments", content: { "application/json": { schema: successEnvelope(z.object({ shipments: z.array(ShipmentResource) })) } } },
    ...readResponses,
  },
}), async (c) => {
  const orderId = c.req.valid("param").id;
  await requireOrderCurrency(c, orderId);
  return ok(c, { shipments: await readOrderShipmentRepresentations(c.get("db"), orderId) });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.shipments.create",
  method: "post",
  path: "/orders/{id}/shipments",
  tags: ["App API - Orders"],
  summary: "Book a courier for an order",
  description: "Books the named courier (an app courier `<app id>:<provider id>` or a built-in one) for the whole order. Send an Idempotency-Key: a repeat returns the first booking instead of booking twice.",
  request: {
    params: idParam,
    headers: idempotencyKeyHeaderSchema,
    body: { required: true, content: { "application/json": { schema: createShipmentBodySchema } } },
  },
  responses: {
    201: { description: "The shipment", content: { "application/json": { schema: successEnvelope(z.object({ shipment: ShipmentResource })) } } },
    ...errorResponses,
    409: conflictResponse,
    503: serviceUnavailableResponse,
  },
}), async (c) => {
  const orderId = c.req.valid("param").id;
  const { shipment: booked } = await bookOrderShipment(c, orderId, c.req.valid("json"));
  const shipment = await readShipmentRepresentation(c.get("db"), booked.id);
  if (!shipment) throw new NotFoundError("Shipment not found");
  return created(c, { shipment });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.shipments.get",
  method: "get",
  path: "/shipments/{id}",
  tags: ["App API - Orders"],
  summary: "Get a shipment",
  request: { params: idParam },
  responses: {
    200: { description: "The shipment", content: { "application/json": { schema: successEnvelope(ShipmentResource) } } },
    ...readResponses,
  },
}), async (c) => {
  const shipment = await readShipmentRepresentation(c.get("db"), c.req.valid("param").id);
  if (!shipment) throw new NotFoundError("Shipment not found");
  return ok(c, shipment);
});

// ─── Products and variants ───────────────────────────────────────────────────

const productsQuery = z.object({
  ...pageQuery,
  status: z.enum(["active", "draft", "trashed"]).optional().openapi({ description: "Omit for active and draft products." }),
  sku: z.string().trim().min(1).max(100).optional().openapi({ description: "The product with this SKU (any case)." }),
  barcode: z.string().trim().min(1).max(50).optional().openapi({ description: "The product with a SKU of this barcode (any case)." }),
  categoryId: z.string().min(1).max(180).optional(),
  brandId: z.string().min(1).max(128).optional(),
});

app.openapi(createRoute({
  operationId: "dashboard.resources.products.list",
  method: "get",
  path: "/products",
  tags: ["App API - Products"],
  summary: "List products, least recently updated first",
  description: "Products with their live SKUs as webhooks carry them (ProductResource), prices in integer minor units of `currency`, in (updatedAt, id) order. Look one up by sku or barcode.",
  request: { query: productsQuery },
  responses: {
    200: { description: "A page of products", content: { "application/json": { schema: successEnvelope(z.object({ products: z.array(ProductResource), nextCursor: nextCursorSchema })) } } },
    ...readResponses,
  },
}), async (c) => {
  const query = c.req.valid("query");
  const db = c.get("db");
  const where: SQL[] = [];
  if (query.status === "trashed") where.push(isNotNull(products.deletedAt));
  else {
    where.push(isNull(products.deletedAt));
    if (query.status) where.push(eq(products.isActive, query.status === "active"));
  }
  if (query.updatedSince) where.push(gte(sql`${products.updatedAt}`, seconds(query.updatedSince)));
  if (query.categoryId) where.push(eq(products.categoryId, query.categoryId));
  if (query.brandId) where.push(eq(products.brandId, query.brandId));
  if (query.sku) {
    where.push(inArray(products.id, db.select({ id: productVariants.productId }).from(productVariants)
      .where(sql`lower(trim(${productVariants.sku})) = ${query.sku.toLowerCase()}`)));
  }
  if (query.barcode) {
    where.push(inArray(products.id, db.select({ id: productVariants.productId }).from(productVariants)
      .where(and(
        sql`lower(trim(${productVariants.barcode})) = ${query.barcode.toLowerCase()}`,
        sql`${productVariants.barcode} IS NOT NULL AND trim(${productVariants.barcode}) <> ''`,
      ))));
  }
  const order = UPDATED_ORDER(products.updatedAt, products.id);
  const page = await resourcePage({
    order,
    cursor: query.cursor,
    limit: query.limit,
    where,
    ids: (condition, limit) => db.select({ id: products.id }).from(products).where(condition).orderBy(...keysetOrderBy(order)).limit(limit).all(),
    load: (ids) => readProductRepresentations(db, ids),
  });
  return ok(c, { products: page.items, nextCursor: page.nextCursor });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.products.get",
  method: "get",
  path: "/products/{id}",
  tags: ["App API - Products"],
  summary: "Get a product",
  description: "The product with its live SKUs as webhooks carry it; prices in integer minor units of `currency`.",
  request: { params: idParam },
  responses: {
    200: { description: "The product", content: { "application/json": { schema: successEnvelope(ProductResource) } } },
    ...readResponses,
  },
}), async (c) => {
  const [product] = await readProductRepresentations(c.get("db"), [c.req.valid("param").id]);
  if (!product) throw new NotFoundError("Product not found");
  return ok(c, product);
});

app.openapi(createRoute({
  operationId: "dashboard.resources.variants.get",
  method: "get",
  path: "/variants/{id}",
  tags: ["App API - Products"],
  summary: "Get a SKU's stock",
  description: "The SKU's on-hand units in total and per location, as `inventory.level_changed` carries it.",
  request: { params: idParam },
  responses: {
    200: { description: "The SKU", content: { "application/json": { schema: successEnvelope(VariantResource) } } },
    ...readResponses,
  },
}), async (c) => {
  const variant = await readVariantRepresentation(c.get("db"), c.req.valid("param").id);
  if (!variant) throw new NotFoundError("Variant not found");
  return ok(c, variant);
});

/** SKUs one lookup reads: one bound list within D1's 100 parameters. */
const VARIANT_LOOKUP_MAX = 90;

app.openapi(createRoute({
  operationId: "dashboard.resources.variants.lookup",
  method: "post",
  path: "/variants/lookup",
  tags: ["App API - Products"],
  summary: "Find SKUs by their codes",
  description: "Up to 90 SKU codes (any case) in one read: each found SKU's stock in total and per location with its stockVersion, in the order asked; codes that match nothing are left out. A read: nothing changes.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: z.object({ skus: z.array(z.string().trim().min(1).max(100)).min(1).max(VARIANT_LOOKUP_MAX) }).strict() } },
    },
  },
  responses: {
    200: { description: "The SKUs found", content: { "application/json": { schema: successEnvelope(z.object({ variants: z.array(VariantResource) })) } } },
    ...readResponses,
  },
}), async (c) => ok(c, { variants: await readVariantRepresentations(c.get("db"), { skus: c.req.valid("json").skus }) }));

// ─── Customers ───────────────────────────────────────────────────────────────

const customersQuery = z.object({
  ...pageQuery,
  email: z.string().trim().email().max(254).optional()
    .openapi({ description: "The customer's email, matched whole. Needs read_customer_emails." }),
  phone: z.string().trim().regex(/^\+[1-9]\d{6,14}$/u, "Use the E.164 number, such as +8801712345678.").optional()
    .openapi({ description: "The customer's phone in E.164, matched whole. Needs read_customer_phones." }),
  tag: z.string().trim().min(1).max(40).optional().openapi({ description: "Customers with this tag (any case)." }),
  trashed: z.enum(["true", "false"]).optional().openapi({ description: "true lists trashed and merged customers instead." }),
});

app.openapi(createRoute({
  operationId: "dashboard.resources.customers.list",
  method: "get",
  path: "/customers",
  tags: ["App API - Customers"],
  summary: "List customers, least recently updated first",
  description: "Customers as webhooks carry them (CustomerResource), in (updatedAt, id) order. Contact fields read null and contact filters are refused without the matching read_customer_* scope.",
  request: { query: customersQuery },
  responses: {
    200: { description: "A page of customers", content: { "application/json": { schema: successEnvelope(z.object({ customers: z.array(CustomerResource), nextCursor: nextCursorSchema })) } } },
    ...readResponses,
  },
}), async (c) => {
  const query = c.req.valid("query");
  if (query.email) assertContactFilterAllowed(c, "email", "email");
  if (query.phone) assertContactFilterAllowed(c, "phone", "phone");
  const db = c.get("db");
  const where: SQL[] = [query.trashed === "true" ? isNotNull(customers.deletedAt) : isNull(customers.deletedAt)];
  if (query.updatedSince) where.push(gte(sql`${customers.updatedAt}`, seconds(query.updatedSince)));
  if (query.email) where.push(inArray(customers.email, [...new Set([query.email, query.email.toLowerCase()])]));
  if (query.phone) where.push(sql`${customers.phone} = ${query.phone}`);
  if (query.tag) {
    where.push(inArray(customers.id, db.select({ id: customerTagLinks.customerId }).from(customerTagLinks)
      .where(eq(customerTagLinks.tag, query.tag.toLowerCase().replace(/\s+/gu, " ")))));
  }
  const order = UPDATED_ORDER(customers.updatedAt, customers.id);
  const page = await resourcePage({
    order,
    cursor: query.cursor,
    limit: query.limit,
    where,
    ids: (condition, limit) => db.select({ id: customers.id }).from(customers).where(condition).orderBy(...keysetOrderBy(order)).limit(limit).all(),
    load: (ids) => readCustomerRepresentations(db, ids),
  });
  return ok(c, { customers: page.items, nextCursor: page.nextCursor });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.customers.get",
  method: "get",
  path: "/customers/{id}",
  tags: ["App API - Customers"],
  summary: "Get a customer",
  description: "The customer as webhooks carry it, with tags and marketing consent. Contact fields read null without the matching read_customer_* scope.",
  request: { params: idParam },
  responses: {
    200: { description: "The customer", content: { "application/json": { schema: successEnvelope(CustomerResource) } } },
    ...readResponses,
  },
}), async (c) => {
  const [customer] = await readCustomerRepresentations(c.get("db"), [c.req.valid("param").id]);
  if (!customer) throw new NotFoundError("Customer not found");
  return ok(c, customer);
});

// ─── Price lists ─────────────────────────────────────────────────────────────
// A market's, a segment's or a sale's fixed prices (docs/MARKETS-DESIGN.md
// D5): the same core writes as the dashboard's editor, in minor units of the
// list's currency.

const PriceListResource = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  kind: z.enum(["market", "segment", "sale"]),
  marketId: z.string(),
  segmentId: z.string().nullable(),
  status: z.enum(["draft", "active"]),
  state: z.enum(["draft", "scheduled", "active", "expired"]).openapi({ description: "What the list does now: its status read with its schedule." }),
  startsAt: z.string().nullable().openapi({ format: "date-time" }),
  endsAt: z.string().nullable().openapi({ format: "date-time" }),
  priority: z.number().int(),
  revision: z.number().int().positive(),
  priceCount: z.number().int().min(0),
  variantCount: z.number().int().min(0),
  /** The market's currency: every price of the list is in it. */
  currency: z.string().length(3),
  priceIncrementMinor: z.number().int().positive().openapi({ description: "Every price is a multiple of this, in minor units of `currency`." }),
  createdAt: z.string().openapi({ format: "date-time" }),
  updatedAt: z.string().openapi({ format: "date-time" }),
}).openapi("PriceListResource");

function priceListResource(record: PriceListRecord): z.infer<typeof PriceListResource> {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    kind: record.kind,
    marketId: record.marketId,
    segmentId: record.segmentId,
    status: record.status,
    state: record.state,
    startsAt: record.startsAt?.toISOString() ?? null,
    endsAt: record.endsAt?.toISOString() ?? null,
    priority: record.priority,
    revision: record.revision,
    priceCount: record.priceCount,
    variantCount: record.variantCount,
    currency: record.currencyCode,
    priceIncrementMinor: record.priceIncrementMinor,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

const priceListEnvelope = successEnvelope(z.object({ priceList: PriceListResource }));
const priceListId = z.object({ id: z.string().min(1).max(64) });
const writeResponses = { ...errorResponses, 409: conflictResponse };

app.openapi(createRoute({
  operationId: "dashboard.resources.price_lists.list",
  method: "get",
  path: "/price-lists",
  tags: ["App API - Products"],
  summary: "List price lists, by name",
  description: "Every price list (a store keeps at most 100) with its market, segment, schedule state and how many SKUs it prices. `marketId` narrows to one market.",
  request: { query: z.object({ marketId: z.string().min(1).max(64).optional() }) },
  responses: {
    200: { description: "Price lists", content: { "application/json": { schema: successEnvelope(z.object({ priceLists: z.array(PriceListResource) })) } } },
    ...readResponses,
  },
}), async (c) => {
  const { marketId } = c.req.valid("query");
  return ok(c, { priceLists: (await listPriceLists(c.get("db"), { marketId })).map(priceListResource) });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.price_lists.get",
  method: "get",
  path: "/price-lists/{id}",
  tags: ["App API - Products"],
  summary: "Get a price list",
  request: { params: priceListId },
  responses: {
    200: { description: "The price list", content: { "application/json": { schema: priceListEnvelope } } },
    ...readResponses,
  },
}), async (c) => ok(c, { priceList: priceListResource(await getPriceList(c.get("db"), c.req.valid("param").id)) }));

app.openapi(createRoute({
  operationId: "dashboard.resources.price_lists.create",
  method: "post",
  path: "/price-lists",
  tags: ["App API - Products"],
  summary: "Create a price list",
  description: "A market list prices a non-backup market for every buyer; a sale list does too, between its start and end, and wins over the market list; a segment list prices the signed-in members of one customer segment in a market. A new list is a draft until set active.",
  request: { body: { required: true, content: { "application/json": { schema: createPriceListSchema } } } },
  responses: {
    201: { description: "The new price list", content: { "application/json": { schema: priceListEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  const { startsAt, endsAt, ...input } = c.req.valid("json");
  const priceList = await createPriceList(c.get("db"), {
    ...input,
    startsAt: scheduleInstant(startsAt) ?? null,
    endsAt: scheduleInstant(endsAt) ?? null,
  });
  return created(c, { priceList: priceListResource(priceList) });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.price_lists.update",
  method: "patch",
  path: "/price-lists/{id}",
  tags: ["App API - Products"],
  summary: "Edit a price list under the revision you read",
  description: "Fields left out keep their value. `status: active` starts pricing (within its schedule); `draft` stops it. A stale expectedRevision is refused with 409.",
  request: { params: priceListId, body: { required: true, content: { "application/json": { schema: updatePriceListSchema } } } },
  responses: {
    200: { description: "The saved price list", content: { "application/json": { schema: priceListEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  const { startsAt, endsAt, ...update } = c.req.valid("json");
  const priceList = await updatePriceList(c.get("db"), c.req.valid("param").id, {
    ...update,
    startsAt: scheduleInstant(startsAt),
    endsAt: scheduleInstant(endsAt),
  });
  return ok(c, { priceList: priceListResource(priceList) });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.price_lists.delete",
  method: "delete",
  path: "/price-lists/{id}",
  tags: ["App API - Products"],
  summary: "Delete a price list and its prices",
  description: "Orders keep the prices they were placed at; the list's SKUs price by the next rule (another list, FX or the product price).",
  request: { params: priceListId, query: z.object({ expectedRevision: z.coerce.number().int().positive() }) },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: successEnvelope(z.object({ id: z.string() })) } } },
    ...writeResponses,
  },
}), async (c) => {
  const { id } = c.req.valid("param");
  await deletePriceList(c.get("db"), id, c.req.valid("query").expectedRevision);
  return ok(c, { id });
});

const PriceListSku = z.object({
  variantId: z.string(),
  productId: z.string(),
  sku: z.string(),
  /** The store currency: the SKU's own price is in it. */
  baseCurrency: z.string().length(3),
  basePriceMinor: z.number().int().openapi({ description: "The SKU's own product price, in minor units of `baseCurrency`." }),
  prices: z.array(z.object({
    currency: z.string().length(3),
    amountMinor: z.number().int(),
    compareAtMinor: z.number().int().nullable(),
    minQuantity: z.number().int(),
  })),
}).openapi("PriceListSku");

app.openapi(createRoute({
  operationId: "dashboard.resources.price_lists.prices_list",
  method: "get",
  path: "/price-lists/{id}/prices",
  tags: ["App API - Products"],
  summary: "One page of a price list's SKUs and their prices",
  description: "By product name then SKU, in minor units. `search` matches the product name or the SKU code.",
  request: {
    params: priceListId,
    query: z.object({
      page: z.coerce.number().int().min(1).max(1_000).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      search: z.string().trim().max(120).optional(),
    }),
  },
  responses: {
    200: {
      description: "The page",
      content: { "application/json": { schema: successEnvelope(z.object({ items: z.array(PriceListSku), total: z.number().int(), page: z.number().int(), limit: z.number().int() })) } },
    },
    ...readResponses,
  },
}), async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const [, page, store] = await Promise.all([getPriceList(db, id), listPriceListVariants(db, id, c.req.valid("query")), readStoreCurrency(db)]);
  return ok(c, {
    ...page,
    items: page.items.map((item) => ({
      variantId: item.variantId,
      productId: item.productId,
      sku: item.sku,
      baseCurrency: store.code,
      basePriceMinor: item.basePriceMinor,
      prices: item.prices.map((price) => ({
        currency: price.currencyCode,
        amountMinor: price.amountMinor,
        compareAtMinor: price.compareAtMinor,
        minQuantity: price.minQuantity,
      })),
    })),
  });
});

const priceTierMinor = z.object({
  amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).openapi({ description: "The price of one unit, in minor units of the list's currency, at its price increment." }),
  compareAtMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional().openapi({ description: "The struck-through price, above the amount; null for none." }),
  minQuantity: z.number().int().min(1).max(PRICE_LIST_MIN_QUANTITY_MAX).default(1).openapi({ description: "1 is the list's price; a larger value is a quantity break from that many units." }),
});

app.openapi(createRoute({
  operationId: "dashboard.resources.price_lists.prices_set",
  method: "put",
  path: "/price-lists/{id}/prices",
  tags: ["App API - Products"],
  summary: "Set or remove SKU prices of a price list",
  description: "`set` replaces each named SKU's prices (its price for one unit and up to four quantity breaks); `remove` takes SKUs out. At most 100 SKUs per save. Amounts are minor units of the list's currency at its price increment; a stale expectedRevision is refused with 409.",
  request: {
    params: priceListId,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            expectedRevision: z.number().int().positive(),
            set: z.array(z.object({
              variantId: z.string().min(1).max(180),
              prices: z.array(priceTierMinor).min(1).max(MAX_PRICE_LIST_QUANTITY_BREAKS),
            })).max(PRICE_LIST_WRITE_MAX_VARIANTS).default([]).openapi({ description: "Each SKU's whole set of prices (it replaces what the SKU had in the list)." }),
            remove: z.array(z.string().min(1).max(180)).max(PRICE_LIST_WRITE_MAX_VARIANTS).default([]).openapi({ description: "SKUs to take out of the list." }),
          }).strict(),
        },
      },
    },
  },
  responses: {
    200: { description: "The saved price list", content: { "application/json": { schema: priceListEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const places = getDecimalPlaces((await getPriceList(db, id)).currencyCode);
  // The core takes the editor's major units; the conversion is exact for every safe minor amount.
  const priceList = await setPriceListPrices(db, id, {
    expectedRevision: body.expectedRevision,
    remove: body.remove,
    set: body.set.map((entry) => ({
      variantId: entry.variantId,
      prices: entry.prices.map((price) => ({
        amount: fromMinor(price.amountMinor, places),
        compareAt: price.compareAtMinor == null ? price.compareAtMinor : fromMinor(price.compareAtMinor, places),
        minQuantity: price.minQuantity,
      })),
    })),
  });
  return ok(c, { priceList: priceListResource(priceList) });
});

export { app as adminResourceRoutes };
