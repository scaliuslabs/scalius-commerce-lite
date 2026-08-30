import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  getInvoiceDocument,
  issueInvoice,
} from "@scalius/core/modules/orders/invoice.service";
import { renderPrintableInvoice } from "@scalius/core/modules/orders/invoice-printable-artifact";
import { NotFoundError } from "../../utils/api-error";
import { ok } from "../../utils/api-response";
import {
  conflictResponse,
  errorResponses,
  serviceUnavailableResponse,
  successEnvelope,
} from "../../schemas/responses";
import { resolveCanonicalIdempotencyKey } from "./idempotency-key";

const app = new OpenAPIHono<{ Bindings: Env }>();

const nullableMoneySchema = z.number().nullable();
const orderItemSchema = z.object({
  id: z.string(),
  productId: z.string(),
  variantId: z.string().nullable(),
  quantity: z.number().int().positive(),
  price: z.number(),
  productName: z.string().nullable(),
  variantLabel: z.string().nullable(),
  fulfillmentStatus: z.string().nullable(),
  unitPriceMinor: nullableMoneySchema,
  lineSubtotalMinor: nullableMoneySchema,
  discountAmountMinor: nullableMoneySchema,
  taxableAmountMinor: nullableMoneySchema,
  taxAmountMinor: nullableMoneySchema,
});

const invoiceOrderSchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  customerName: z.string(),
  customerPhone: z.string(),
  customerEmail: z.string().nullable(),
  customerId: z.string().nullable(),
  shippingAddress: z.string().nullable(),
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
  createdAt: z.union([z.string(), z.number()]),
  updatedAt: z.union([z.string(), z.number()]),
  items: z.array(orderItemSchema),
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
  request: { params: paramsSchema },
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

app.openapi(getInvoiceRoute, async (c) => {
  const document = await getInvoiceDocument(c.get("db"), c.req.valid("param").id);
  if (!document) throw new NotFoundError("Order not found");
  return ok(c, document);
});

app.openapi(issueInvoiceRoute, async (c) => {
  const user = c.get("user") as { id?: string } | undefined;
  const { operationKey: bodyOperationKey, ...payload } = c.req.valid("json");
  const operationKey = resolveCanonicalIdempotencyKey(
    c.req.valid("header")["idempotency-key"],
    bodyOperationKey,
    "operationKey",
  );
  const document = await issueInvoice(
    c.get("db"),
    c.req.valid("param").id,
    { ...payload, operationKey },
    user?.id ?? null,
  );
  return ok(c, document);
});

app.openapi(printInvoiceRoute, async (c) => {
  const document = await getInvoiceDocument(c.get("db"), c.req.valid("param").id);
  if (!document) throw new NotFoundError("Order not found");
  const basename = (document.invoiceNumber ?? `draft-${document.order.id}`)
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .slice(0, 100);
  const artifact = renderPrintableInvoice(document);
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
