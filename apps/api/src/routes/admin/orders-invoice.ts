import { createRoute, z } from "@hono/zod-openapi";
import { adminRouter } from "./admin-router";
import {
  recordOrderEvent,
  getInvoiceDocument,
  issueInvoice,
  renderPrintableInvoice,
} from "@scalius/core/modules/orders";
import { readOrderMessageScope } from "@scalius/core/modules/notifications";
import { checkoutAttributeAppsSchema } from "../../schemas/checkout-attribute-apps";
import { NotFoundError } from "../../utils/api-error";
import { appOwnedField, protectedField as pii } from "../../schemas/protected";
import { ok } from "../../utils/api-response";
import {
  conflictResponse,
  errorResponses,
  serviceUnavailableResponse,
  successEnvelope,
} from "../../schemas/responses";
import { principalIdempotencyKey } from "./idempotency-key";
import { storeTimeZoneOf } from "../../utils/store-time-zone";
import { requestActorId, requestStaffId } from "./request-actor";

const app = adminRouter();

const nullableMoneySchema = z.number().nullable();
const orderItemSchema = z.object({
  id: z.string(),
  productId: z.string(),
  variantId: z.string().nullable(),
  quantity: z.number().int().positive(),
  price: z.number(),
  productName: z.string().nullable(),
  variantLabel: z.string().nullable(),
  unitPriceMinor: nullableMoneySchema,
  lineSubtotalMinor: nullableMoneySchema,
  discountAmountMinor: nullableMoneySchema,
  taxableAmountMinor: nullableMoneySchema,
  taxAmountMinor: nullableMoneySchema,
  returnedQuantity: z.number().int().nonnegative().optional(),
});

/** One invoice line as frozen in the invoice snapshot. */
const invoiceItemSchema = orderItemSchema.extend({
  /** Buyer inputs printed under the line; absent on invoices issued before Wave A. An app reads only its own (COMMERCE-HOOKS H13). */
  properties: appOwnedField("items", z.array(z.object({
    /** The entry's key, type and stored value (`presentLineEntry` writes the platform's words from them); absent on older invoices. */
    key: z.string().optional(),
    type: z.string().optional(),
    value: z.string().optional(),
    label: z.string(),
    displayValue: z.string(),
    /** Surcharge per unit in minor units; 0 when free. */
    priceMinor: z.number().int(),
  }))).optional(),
});

const invoiceOrderSchema = z.object({
  id: z.string(),
  orderNumber: z.number().int().nullable().optional(),
  version: z.number().int().positive(),
  customerName: pii("name", z.string()),
  customerPhone: pii("phone", z.string().nullable().openapi({ description: "E.164; null for an order placed without a phone (only digital or service lines, Customer accounts opt-in)." })),
  customerEmail: pii("email", z.string().nullable()),
  customerId: z.string().nullable(),
  shippingAddress: pii("address", z.string().nullable()),
  /** The rest of the address snapshot; absent on invoices issued before 0113 (Bangladesh addresses). */
  shippingAddressLine2: pii("address", z.string().nullable()).optional(),
  shippingCountryCode: z.string().nullable().optional(),
  shippingDependentLocality: pii("address", z.string().nullable()).optional(),
  shippingLocality: z.string().nullable().optional(),
  shippingAdminArea: z.string().nullable().optional(),
  shippingPostalCode: z.string().nullable().optional(),
  shippingCompany: pii("address", z.string().nullable()).optional(),
  shippingName: pii("name", z.string().nullable()).optional(),
  shippingPhone: pii("phone", z.string().nullable()).optional(),
  /** The billing snapshot; absent on invoices issued before 0119 (no billing address). */
  billingSameAsShipping: z.boolean().optional(),
  billingName: pii("name", z.string().nullable()).optional(),
  billingCompany: pii("address", z.string().nullable()).optional(),
  billingAddress: pii("address", z.string().nullable()).optional(),
  billingAddressLine2: pii("address", z.string().nullable()).optional(),
  billingCountryCode: z.string().nullable().optional(),
  billingDependentLocality: pii("address", z.string().nullable()).optional(),
  billingLocality: z.string().nullable().optional(),
  billingAdminArea: z.string().nullable().optional(),
  billingPostalCode: z.string().nullable().optional(),
  city: z.string().nullable(),
  zone: z.string().nullable(),
  area: z.string().nullable(),
  cityName: z.string().nullable(),
  zoneName: z.string().nullable(),
  areaName: z.string().nullable(),
  totalAmount: z.number(),
  shippingCharge: z.number(),
  discountAmount: z.number().nullable(),
  currencyCode: z.string().nullable(),
  currencyDecimalPlaces: z.number().int().nullable(),
  subtotalAmountMinor: nullableMoneySchema,
  shippingAmountMinor: nullableMoneySchema,
  shippingMethodId: z.string().nullable(),
  shippingMethodName: z.string().nullable(),
  shippingMethodDescription: z.string().nullable(),
  shippingMethodBaseAmountMinor: nullableMoneySchema,
  shippingFeeWaived: z.boolean().nullable(),
  discountAmountMinor: nullableMoneySchema,
  taxAmountMinor: z.number(),
  totalAmountMinor: nullableMoneySchema,
  taxLabel: z.string().nullable(),
  pricesIncludeTax: z.boolean(),
  status: z.string(),
  paymentStatus: z.string().nullable(),
  paymentMethod: z.string().nullable(),
  fulfillmentStatus: z.string().nullable(),
  paidAmount: z.number().nullable(),
  balanceDue: z.number().nullable(),
  refundedAmount: z.number().optional(),
  discounts: z.array(z.object({
    name: z.string(),
    code: z.string().nullable(),
    kind: z.string().optional(),
    /** Everything this discount saved (items and delivery). */
    amount: z.number(),
    /** The part off delivery, shown on the delivery line; absent on older invoices. */
    shippingAmount: z.number().optional(),
  })).optional(),
  paymentTerms: z.object({
    kind: z.literal("net"),
    days: z.number().int().positive(),
    dueAt: z.string().openapi({ description: "ISO 8601 due date: placement plus the net days." }),
  }).nullable().optional().openapi({ description: "Net terms of an invoice paid later; null when the order is paid now, absent on invoices issued before terms were printed." }),
  /** The apps' checkout answers the buyer gave and their words; absent before snapshot version 6. */
  appAnswers: z.record(z.string(), z.string()).optional(),
  attributeApps: checkoutAttributeAppsSchema.optional(),
  taxExemption: z.object({ exemptionId: z.string().nullable() }).nullable().optional()
    .openapi({ description: "The buyer was tax-exempt when the order was priced (no tax charged), with their certificate or registration number; null when not, absent on invoices issued before exemptions were printed." }),
  createdAt: z.union([z.string(), z.number()]),
  updatedAt: z.union([z.string(), z.number()]),
  items: z.array(invoiceItemSchema),
});

const businessInfoSchema = z.object({
  companyName: z.string(),
  legalName: z.string(),
  addressLine1: z.string(),
  addressLine2: z.string(),
  city: z.string(),
  stateRegion: z.string(),
  postalCode: z.string(),
  country: z.string(),
  phone: z.string(),
  email: z.string(),
  taxId: z.string(),
  invoicePrefix: z.string(),
  invoiceFooterText: z.string(),
  invoiceLogoUrl: z.string(),
});

const invoiceDataSchema = z.object({
  status: z.enum(["draft", "issued"]),
  order: invoiceOrderSchema,
  invoiceNumber: z.string().nullable(),
  invoiceNum: z.number().int().positive().nullable(),
  businessInfo: businessInfoSchema,
  issuedAt: z.number().int().nullable(),
  contentHash: z.string().length(64).nullable(),
  renderVersion: z.literal("invoice-v1"),
  orderVersion: z.number().int().positive(),
  /** Refunds made after the invoice was issued; the issued invoice itself never changes. */
  refundedSinceIssue: z.number().optional(),
  buyerLanguage: z.enum(["en", "bn"]).openapi({
    description: "The language the buyer's copy prints in: the order's presence's, else the store's (as the buyer's emails speak it). A staff copy prints in the staff member's.",
  }),
});

const paramsSchema = z.object({
  id: z.string().openapi({ description: "Order ID" }),
});
const invoiceOperationKeySchema = z.string().trim().min(8).max(200);
const invoiceIdempotencyHeadersSchema = z.object({
  "idempotency-key": invoiceOperationKeySchema.optional().openapi({
    description: "Standard retry key. May replace body.operationKey; if both are sent they must match.",
  }),
});

const getInvoiceRoute = createRoute({
  operationId: "dashboard.orders.invoice_get",
  method: "get",
  path: "/{id}/invoice",
  tags: ["Admin - Orders"],
  summary: "Read an invoice or unnumbered draft without changing state",
  request: { params: paramsSchema },
  responses: {
    200: {
      description: "Immutable issued invoice or live unnumbered draft",
      content: { "application/json": { schema: successEnvelope(invoiceDataSchema) } },
    },
    409: conflictResponse,
    503: serviceUnavailableResponse,
    ...errorResponses,
  },
});

const issueInvoiceRoute = createRoute({
  operationId: "dashboard.orders.invoice_issue",
  method: "post",
  path: "/{id}/invoice",
  tags: ["Admin - Orders"],
  summary: "Issue an immutable invoice with atomic monotonic numbering",
  request: {
    params: paramsSchema,
    headers: invoiceIdempotencyHeadersSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            operationKey: invoiceOperationKeySchema.optional(),
            expectedOrderVersion: z.number().int().min(1),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Issued invoice or exact idempotent replay",
      content: { "application/json": { schema: successEnvelope(invoiceDataSchema) } },
    },
    409: conflictResponse,
    503: serviceUnavailableResponse,
    ...errorResponses,
  },
});

const printInvoiceRoute = createRoute({
  operationId: "dashboard.orders.invoice_print",
  method: "get",
  path: "/{id}/invoice/print",
  tags: ["Admin - Orders"],
  summary: "Render a bounded self-contained printable invoice artifact",
  request: {
    params: paramsSchema,
    query: z.object({
      language: z.enum(["en", "bn"]).optional().openapi({
        description: "The language to print in: the staff member's for a staff copy. Absent: the buyer's copy, in the order's language (`buyerLanguage`).",
      }),
    }),
  },
  responses: {
    200: {
      description: "Private printable HTML invoice",
      content: { "text/html": { schema: z.string() } },
    },
    409: conflictResponse,
    503: serviceUnavailableResponse,
    ...errorResponses,
  },
});

/** The order's buyer language (`readOrderMessageScope`): the language its buyer's invoice prints in. */
async function buyerLanguageOf(db: Parameters<typeof readOrderMessageScope>[0], orderId: string) {
  return (await readOrderMessageScope(db, orderId)).language;
}

app.openapi(getInvoiceRoute, async (c) => {
  const id = c.req.valid("param").id;
  const [document, buyerLanguage] = await Promise.all([getInvoiceDocument(c.get("db"), id), buyerLanguageOf(c.get("db"), id)]);
  if (!document) throw new NotFoundError("Order not found");
  return ok(c, { ...document, buyerLanguage });
});

app.openapi(issueInvoiceRoute, async (c) => {
  const actingStaffId = requestStaffId(c);
  const { operationKey: bodyOperationKey, ...payload } = c.req.valid("json");
  const operationKey = await principalIdempotencyKey(
    c,
    "dashboard.orders.invoice_issue",
    c.req.valid("header")["idempotency-key"],
    bodyOperationKey,
    "operationKey",
  );
  const document = await issueInvoice(
    c.get("db"),
    c.req.valid("param").id,
    { ...payload, operationKey },
    requestActorId(c),
  );
  await recordOrderEvent(c.get("db"), {
    orderId: c.req.valid("param").id,
    kind: "invoice_issued",
    actorId: actingStaffId,
    data: { number: document.invoiceNumber },
  });
  return ok(c, { ...document, buyerLanguage: await buyerLanguageOf(c.get("db"), c.req.valid("param").id) });
});

app.openapi(printInvoiceRoute, async (c) => {
  const id = c.req.valid("param").id;
  const requested = c.req.valid("query").language;
  const [document, language] = await Promise.all([getInvoiceDocument(c.get("db"), id), requested ?? buyerLanguageOf(c.get("db"), id)]);
  if (!document) throw new NotFoundError("Order not found");
  const basename = (document.invoiceNumber ?? `draft-${document.order.id}`)
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .slice(0, 100);
  const artifact = renderPrintableInvoice(document, storeTimeZoneOf(c.env), language);
  const artifactBytes = new TextEncoder().encode(artifact).byteLength;
  return c.html(artifact, 200, {
    "Cache-Control": "private, no-store",
    "Content-Disposition": `attachment; filename="invoice-${basename}.html"`,
    "Content-Length": String(artifactBytes),
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Artifact-Bytes": String(artifactBytes),
    "X-Content-Type-Options": "nosniff",
  });
});

export { app as adminOrdersInvoiceRoutes };
