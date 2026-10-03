// Admin OpenAPI routes for purchasing and transfers (migration 0109):
// suppliers, purchase orders (create, edit, order, receive, cancel, export)
// and transfers between locations (create, edit, ship, receive, cancel).
// Reads need products.view; writes products.edit (RBAC route map). Stock
// commands (receive, ship, cancel in transit) require an Idempotency-Key;
// edits and status changes require the document's current revision.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  archiveSupplier,
  buildPurchaseOrderCsv,
  cancelPurchaseOrder,
  cancelTransfer,
  createPurchaseOrder,
  createPurchaseOrderSchema,
  createSupplier,
  createTransfer,
  createTransferSchema,
  deletePurchaseOrder,
  deleteTransfer,
  getPurchaseOrder,
  getSupplier,
  getTransfer,
  inventoryOperationKeySchema,
  listPurchaseOrders,
  listSuppliers,
  listTransfers,
  markPurchaseOrderOrdered,
  PURCHASE_ORDER_MAX_LINES,
  receivePurchaseOrder,
  receiveTransfer,
  shipTransfer,
  supplierInputSchema,
  unarchiveSupplier,
  updatePurchaseOrder,
  updatePurchaseOrderSchema,
  updateSupplier,
  updateSupplierSchema,
  updateTransfer,
  updateTransferSchema,
  INVENTORY_TRANSFER_MAX_LINES,
} from "@scalius/core/modules/inventory";
import {
  INVENTORY_TRANSFER_STATUSES,
  INVENTORY_TRANSFER_MOVEMENT_KINDS,
  PURCHASE_ORDER_STATUSES,
  SUPPLIER_STATUSES,
} from "@scalius/database/schema";
import { ValidationError } from "../../utils/api-error";
import { ok } from "../../utils/api-response";
import { conflictResponse, errorResponses, paginationSchema, successEnvelope } from "../../schemas/responses";
import { nullableTimestampSchema, timestampSchema } from "../../schemas/timestamps";

const TAG = "Admin - Inventory";

const idempotencyHeaders = z.object({
  "idempotency-key": inventoryOperationKeySchema.optional().openapi({
    description: "Retry key for this stock command. May replace body.operationKey; if both are sent they must match.",
  }),
});

function operationKeyFrom(header: string | undefined, body: string | undefined): string {
  if (header && body && header !== body) throw new ValidationError("Idempotency-Key header must match body.operationKey.");
  const key = header ?? body;
  if (!key) throw new ValidationError("Idempotency-Key header or body.operationKey is required.");
  return key;
}

const revisionBody = z.object({
  expectedRevision: z.number().int().min(1).openapi({ description: "The document's current revision" }),
});

// ─── Suppliers ──────────────────────────────────────────────────────────

const supplierSchema = z.object({
  id: z.string(),
  name: z.string(),
  contactName: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  notes: z.string().nullable(),
  status: z.enum(SUPPLIER_STATUSES),
  version: z.number().int(),
  openPurchaseOrders: z.number().int().openapi({ description: "Purchase orders still expected from this supplier" }),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
const supplierEnvelope = successEnvelope(supplierSchema);
const supplierParams = z.object({ supplierId: z.string().trim().min(1).max(100) });

export const adminSupplierRoutes = new OpenAPIHono<{ Bindings: Env }>();

adminSupplierRoutes.openapi(createRoute({
  method: "get",
  path: "/",
  operationId: "dashboard.inventory_suppliers.list",
  tags: [TAG],
  summary: "List suppliers",
  description: "Active suppliers by name (archived ones with status=archived or all). Searches name, contact, phone and email.",
  request: {
    query: z.object({
      q: z.string().trim().max(120).optional(),
      status: z.enum([...SUPPLIER_STATUSES, "all"]).optional().default("active"),
      page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
      limit: z.coerce.number().int().min(1).max(100).optional().default(50),
    }),
  },
  responses: {
    200: {
      description: "Suppliers",
      content: { "application/json": { schema: successEnvelope(z.object({ suppliers: z.array(supplierSchema), pagination: paginationSchema })) } },
    },
  },
}), async (c) => ok(c, await listSuppliers(c.get("db"), c.req.valid("query"))));

adminSupplierRoutes.openapi(createRoute({
  method: "post",
  path: "/",
  operationId: "dashboard.inventory_suppliers.create",
  tags: [TAG],
  summary: "Add a supplier",
  request: { body: { content: { "application/json": { schema: supplierInputSchema } } } },
  responses: { 200: { description: "Supplier added", content: { "application/json": { schema: supplierEnvelope } } }, 400: errorResponses[400] },
}), async (c) => ok(c, await createSupplier(c.get("db"), c.req.valid("json"))));

adminSupplierRoutes.openapi(createRoute({
  method: "get",
  path: "/{supplierId}",
  operationId: "dashboard.inventory_suppliers.get",
  tags: [TAG],
  summary: "Get a supplier",
  request: { params: supplierParams },
  responses: { 200: { description: "Supplier", content: { "application/json": { schema: supplierEnvelope } } }, 404: errorResponses[404] },
}), async (c) => ok(c, await getSupplier(c.get("db"), c.req.valid("param").supplierId)));

adminSupplierRoutes.openapi(createRoute({
  method: "patch",
  path: "/{supplierId}",
  operationId: "dashboard.inventory_suppliers.update",
  tags: [TAG],
  summary: "Edit a supplier",
  description: "Replaces the supplier's details; expectedVersion must be its current version.",
  request: { params: supplierParams, body: { content: { "application/json": { schema: updateSupplierSchema } } } },
  responses: {
    200: { description: "Supplier saved", content: { "application/json": { schema: supplierEnvelope } } },
    400: errorResponses[400],
    404: errorResponses[404],
    409: conflictResponse,
  },
}), async (c) => ok(c, await updateSupplier(c.get("db"), c.req.valid("param").supplierId, c.req.valid("json"))));

adminSupplierRoutes.openapi(createRoute({
  method: "post",
  path: "/{supplierId}/archive",
  operationId: "dashboard.inventory_suppliers.archive",
  tags: [TAG],
  summary: "Archive a supplier",
  description: "Refused while purchase orders are still expected from the supplier.",
  request: { params: supplierParams },
  responses: {
    200: { description: "Supplier archived", content: { "application/json": { schema: supplierEnvelope } } },
    404: errorResponses[404],
    409: conflictResponse,
  },
}), async (c) => ok(c, await archiveSupplier(c.get("db"), c.req.valid("param").supplierId)));

adminSupplierRoutes.openapi(createRoute({
  method: "post",
  path: "/{supplierId}/unarchive",
  operationId: "dashboard.inventory_suppliers.unarchive",
  tags: [TAG],
  summary: "Make an archived supplier active again",
  request: { params: supplierParams },
  responses: { 200: { description: "Supplier active", content: { "application/json": { schema: supplierEnvelope } } }, 404: errorResponses[404] },
}), async (c) => ok(c, await unarchiveSupplier(c.get("db"), c.req.valid("param").supplierId)));

// ─── Purchase orders ────────────────────────────────────────────────────

const poStatus = z.enum(PURCHASE_ORDER_STATUSES);
const purchaseOrderSummarySchema = z.object({
  id: z.string(),
  number: z.number().int(),
  displayNumber: z.string().openapi({ description: "PO1001" }),
  status: poStatus,
  supplier: z.object({ id: z.string(), name: z.string() }).nullable(),
  destination: z.object({ id: z.string(), name: z.string() }),
  expectedOn: z.string().nullable().openapi({ description: "Expected arrival date (YYYY-MM-DD)" }),
  reference: z.string().nullable(),
  currencyCode: z.string(),
  lineCount: z.number().int(),
  quantity: z.number().int(),
  receivedQuantity: z.number().int(),
  subtotal: z.number().openapi({ description: "Σ quantity × unit cost, major units" }),
  total: z.number().openapi({ description: "Subtotal + shipping + other costs + tax" }),
  revision: z.number().int(),
  orderedAt: nullableTimestampSchema,
  receivedAt: nullableTimestampSchema,
  cancelledAt: nullableTimestampSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

const purchaseOrderDetailSchema = purchaseOrderSummarySchema.extend({
  supplier: z.object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    contactName: z.string().nullable(),
  }).nullable(),
  destination: z.object({ id: z.string(), name: z.string(), code: z.string(), status: z.string() }),
  notes: z.string().nullable(),
  shipping: z.number(),
  otherCosts: z.number(),
  tax: z.number(),
  createdBy: z.string().nullable(),
  lines: z.array(z.object({
    id: z.string(),
    variantId: z.string(),
    productId: z.string(),
    productName: z.string().nullable(),
    sku: z.string(),
    barcode: z.string().nullable(),
    optionLabel: z.string().nullable(),
    retired: z.boolean().openapi({ description: "The SKU was removed from its product" }),
    position: z.number().int(),
    quantity: z.number().int(),
    receivedQuantity: z.number().int(),
    openQuantity: z.number().int(),
    unitCost: z.number(),
    lineTotal: z.number(),
    currentCost: z.number().nullable().openapi({ description: "The SKU's unit cost now" }),
  })),
  receipts: z.array(z.object({
    operationKey: z.string(),
    createdAt: timestampSchema,
    actorName: z.string(),
    lines: z.array(z.object({
      lineId: z.string(),
      variantId: z.string(),
      sku: z.string(),
      quantity: z.number().int(),
      unitCost: z.number(),
      costBefore: z.number().nullable(),
      costAfter: z.number().nullable(),
      costUpdated: z.boolean(),
    })),
  })),
});
const purchaseOrderEnvelope = successEnvelope(purchaseOrderDetailSchema.openapi("PurchaseOrder"));
const poParams = z.object({ purchaseOrderId: z.string().trim().min(1).max(100) });

export const adminPurchaseOrderRoutes = new OpenAPIHono<{ Bindings: Env }>();

adminPurchaseOrderRoutes.openapi(createRoute({
  method: "get",
  path: "/",
  operationId: "dashboard.purchase_orders.list",
  tags: [TAG],
  summary: "List purchase orders",
  description: "Newest first. status=open lists ordered and partially received ones. q searches the number (PO1001), reference, supplier, SKU and barcode.",
  request: {
    query: z.object({
      q: z.string().trim().max(120).optional(),
      status: z.enum([...PURCHASE_ORDER_STATUSES, "open", "all"]).optional().default("all"),
      supplierId: z.string().trim().min(1).max(100).optional(),
      locationId: z.string().trim().min(1).max(100).optional(),
      page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
      limit: z.coerce.number().int().min(1).max(100).optional().default(50),
    }),
  },
  responses: {
    200: {
      description: "Purchase orders",
      content: { "application/json": { schema: successEnvelope(z.object({ purchaseOrders: z.array(purchaseOrderSummarySchema), pagination: paginationSchema })) } },
    },
  },
}), async (c) => ok(c, await listPurchaseOrders(c.get("db"), c.req.valid("query"))));

adminPurchaseOrderRoutes.openapi(createRoute({
  method: "post",
  path: "/",
  operationId: "dashboard.purchase_orders.create",
  tags: [TAG],
  summary: "Create a draft purchase order",
  description: `Lines are live physical SKUs, each once, at most ${PURCHASE_ORDER_MAX_LINES}; costs are major units. The destination is the default location when omitted.`,
  request: { body: { content: { "application/json": { schema: createPurchaseOrderSchema } } } },
  responses: {
    200: { description: "Draft created", content: { "application/json": { schema: purchaseOrderEnvelope } } },
    400: errorResponses[400],
    404: errorResponses[404],
  },
}), async (c) => ok(c, await createPurchaseOrder(c.get("db"), c.req.valid("json"), c.get("user")?.id)));

adminPurchaseOrderRoutes.openapi(createRoute({
  method: "get",
  path: "/{purchaseOrderId}",
  operationId: "dashboard.purchase_orders.get",
  tags: [TAG],
  summary: "Get a purchase order with its lines and receipts",
  request: { params: poParams },
  responses: { 200: { description: "Purchase order", content: { "application/json": { schema: purchaseOrderEnvelope } } }, 404: errorResponses[404] },
}), async (c) => ok(c, await getPurchaseOrder(c.get("db"), c.req.valid("param").purchaseOrderId)));

adminPurchaseOrderRoutes.openapi(createRoute({
  method: "put",
  path: "/{purchaseOrderId}",
  operationId: "dashboard.purchase_orders.update",
  tags: [TAG],
  summary: "Edit a purchase order",
  description: "A draft takes any change (sent lines replace its lines). Once ordered only the supplier, expected date, reference, notes, shipping, other costs and tax change. expectedRevision must be current.",
  request: { params: poParams, body: { content: { "application/json": { schema: updatePurchaseOrderSchema } } } },
  responses: {
    200: { description: "Purchase order saved", content: { "application/json": { schema: purchaseOrderEnvelope } } },
    400: errorResponses[400],
    404: errorResponses[404],
    409: conflictResponse,
  },
}), async (c) => ok(c, await updatePurchaseOrder(c.get("db"), c.req.valid("param").purchaseOrderId, c.req.valid("json"))));

adminPurchaseOrderRoutes.openapi(createRoute({
  method: "post",
  path: "/{purchaseOrderId}/order",
  operationId: "dashboard.purchase_orders.mark_ordered",
  tags: [TAG],
  summary: "Mark a draft purchase order as ordered",
  description: "Its lines become incoming stock at the destination and can no longer change.",
  request: { params: poParams, body: { content: { "application/json": { schema: revisionBody } } } },
  responses: {
    200: { description: "Purchase order ordered", content: { "application/json": { schema: purchaseOrderEnvelope } } },
    400: errorResponses[400],
    404: errorResponses[404],
    409: conflictResponse,
  },
}), async (c) => ok(c, await markPurchaseOrderOrdered(c.get("db"), c.req.valid("param").purchaseOrderId, c.req.valid("json").expectedRevision)));

const receiptResultSchema = z.object({
  purchaseOrderId: z.string(),
  displayNumber: z.string(),
  status: poStatus,
  revision: z.number().int(),
  locationId: z.string(),
  costUpdated: z.boolean(),
  lines: z.array(z.object({
    lineId: z.string(),
    variantId: z.string(),
    sku: z.string(),
    quantity: z.number().int(),
    movementId: z.string(),
    unitCost: z.number(),
    costBefore: z.number().nullable(),
    costAfter: z.number().nullable(),
    stockAfter: z.number().int().openapi({ description: "The SKU's on-hand across every location after the receipt" }),
  })),
});

adminPurchaseOrderRoutes.openapi(createRoute({
  method: "post",
  path: "/{purchaseOrderId}/receive",
  operationId: "dashboard.purchase_orders.receive",
  tags: [TAG],
  summary: "Receive stock on a purchase order",
  description: "Books some or all of the open quantities at the PO's destination: one ledger `received` movement per SKU with its stock compare-and-set, the receipt's unit costs (cost history) and the new PO status, in one atomic write. updateCost moves each SKU's unit cost to the weighted average of its on-hand units and the received ones. An exact retry with the same Idempotency-Key replays the result.",
  request: {
    params: poParams,
    headers: idempotencyHeaders,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            operationKey: inventoryOperationKeySchema.optional(),
            lines: z.array(z.object({
              lineId: z.string().trim().min(1).max(100),
              quantity: z.number().int().min(1).max(1_000_000),
            })).min(1).max(PURCHASE_ORDER_MAX_LINES),
            updateCost: z.boolean().optional().default(false),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Stock received", content: { "application/json": { schema: successEnvelope(receiptResultSchema) } } },
    400: errorResponses[400],
    404: errorResponses[404],
    409: conflictResponse,
  },
}), async (c) => {
  const { operationKey, ...body } = c.req.valid("json");
  const key = operationKeyFrom(c.req.valid("header")["idempotency-key"], operationKey);
  return ok(c, await receivePurchaseOrder(c.get("db"), c.req.valid("param").purchaseOrderId, { ...body, operationKey: key }, c.get("user")?.id));
});

adminPurchaseOrderRoutes.openapi(createRoute({
  method: "post",
  path: "/{purchaseOrderId}/cancel",
  operationId: "dashboard.purchase_orders.cancel",
  tags: [TAG],
  summary: "Cancel a purchase order",
  description: "Stops what is still to come; units already received stay in stock.",
  request: { params: poParams, body: { content: { "application/json": { schema: revisionBody } } } },
  responses: {
    200: { description: "Purchase order cancelled", content: { "application/json": { schema: purchaseOrderEnvelope } } },
    404: errorResponses[404],
    409: conflictResponse,
  },
}), async (c) => ok(c, await cancelPurchaseOrder(c.get("db"), c.req.valid("param").purchaseOrderId, c.req.valid("json").expectedRevision)));

adminPurchaseOrderRoutes.openapi(createRoute({
  method: "delete",
  path: "/{purchaseOrderId}",
  operationId: "dashboard.purchase_orders.delete",
  tags: [TAG],
  summary: "Delete a draft purchase order",
  description: "Drafts only; an ordered purchase order is cancelled instead.",
  request: { params: poParams, query: z.object({ expectedRevision: z.coerce.number().int().min(1) }) },
  responses: {
    200: { description: "Draft deleted", content: { "application/json": { schema: successEnvelope(z.object({ id: z.string(), deleted: z.literal(true) })) } } },
    404: errorResponses[404],
    409: conflictResponse,
  },
}), async (c) => ok(c, await deletePurchaseOrder(c.get("db"), c.req.valid("param").purchaseOrderId, c.req.valid("query").expectedRevision)));

adminPurchaseOrderRoutes.openapi(createRoute({
  method: "get",
  path: "/{purchaseOrderId}/export",
  operationId: "dashboard.purchase_orders.export",
  tags: [TAG],
  summary: "Download a purchase order as CSV",
  request: { params: poParams },
  responses: {
    200: { description: "Purchase order CSV attachment", content: { "text/csv": { schema: z.string() } } },
    404: errorResponses[404],
  },
}), async (c) => {
  const artifact = await buildPurchaseOrderCsv(c.get("db"), c.req.valid("param").purchaseOrderId);
  c.header("Content-Type", artifact.contentType);
  c.header("Content-Disposition", `attachment; filename="${artifact.filename}"`);
  c.header("Content-Length", String(artifact.byteLength));
  c.header("Cache-Control", "private, no-store");
  c.header("X-Content-Type-Options", "nosniff");
  return c.body(artifact.body);
});

// ─── Transfers ──────────────────────────────────────────────────────────

const transferStatus = z.enum(INVENTORY_TRANSFER_STATUSES);
const transferSummarySchema = z.object({
  id: z.string(),
  number: z.number().int(),
  displayNumber: z.string().openapi({ description: "T1001" }),
  status: transferStatus,
  origin: z.object({ id: z.string(), name: z.string() }),
  destination: z.object({ id: z.string(), name: z.string() }),
  expectedOn: z.string().nullable(),
  reference: z.string().nullable(),
  lineCount: z.number().int(),
  quantity: z.number().int(),
  receivedQuantity: z.number().int(),
  returnedQuantity: z.number().int(),
  inTransitQuantity: z.number().int().openapi({ description: "Shipped, not yet received or returned: out of both locations and of stock" }),
  revision: z.number().int(),
  shippedAt: nullableTimestampSchema,
  receivedAt: nullableTimestampSchema,
  cancelledAt: nullableTimestampSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
const locationRef = z.object({ id: z.string(), name: z.string(), code: z.string(), status: z.string() });
const transferDetailSchema = transferSummarySchema.extend({
  origin: locationRef,
  destination: locationRef,
  notes: z.string().nullable(),
  createdBy: z.string().nullable(),
  lines: z.array(z.object({
    id: z.string(),
    variantId: z.string(),
    productId: z.string(),
    productName: z.string().nullable(),
    sku: z.string(),
    barcode: z.string().nullable(),
    optionLabel: z.string().nullable(),
    retired: z.boolean(),
    position: z.number().int(),
    quantity: z.number().int(),
    shippedQuantity: z.number().int(),
    receivedQuantity: z.number().int(),
    returnedQuantity: z.number().int(),
    inTransitQuantity: z.number().int(),
  })),
  activity: z.array(z.object({
    operationKey: z.string(),
    kind: z.enum(INVENTORY_TRANSFER_MOVEMENT_KINDS),
    createdAt: timestampSchema,
    actorName: z.string(),
    lines: z.array(z.object({ lineId: z.string(), variantId: z.string(), sku: z.string(), quantity: z.number().int(), locationId: z.string() })),
  })),
});
const transferEnvelope = successEnvelope(transferDetailSchema.openapi("InventoryTransfer"));
const transferCommandSchema = z.object({
  transferId: z.string(),
  displayNumber: z.string(),
  kind: z.enum(INVENTORY_TRANSFER_MOVEMENT_KINDS),
  status: transferStatus,
  revision: z.number().int(),
  locationId: z.string().nullable(),
  lines: z.array(z.object({
    lineId: z.string(),
    variantId: z.string(),
    sku: z.string(),
    quantity: z.number().int(),
    movementId: z.string(),
    stockAfter: z.number().int(),
  })),
});
const transferParams = z.object({ transferId: z.string().trim().min(1).max(100) });
const keyBody = z.object({ operationKey: inventoryOperationKeySchema.optional() });

export const adminTransferRoutes = new OpenAPIHono<{ Bindings: Env }>();

adminTransferRoutes.openapi(createRoute({
  method: "get",
  path: "/",
  operationId: "dashboard.inventory_transfers.list",
  tags: [TAG],
  summary: "List transfers between locations",
  description: "Newest first. status=open lists in-transit and partially received ones; locationId matches the origin or destination.",
  request: {
    query: z.object({
      q: z.string().trim().max(120).optional(),
      status: z.enum([...INVENTORY_TRANSFER_STATUSES, "open", "all"]).optional().default("all"),
      locationId: z.string().trim().min(1).max(100).optional(),
      page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
      limit: z.coerce.number().int().min(1).max(100).optional().default(50),
    }),
  },
  responses: {
    200: {
      description: "Transfers",
      content: { "application/json": { schema: successEnvelope(z.object({ transfers: z.array(transferSummarySchema), pagination: paginationSchema })) } },
    },
  },
}), async (c) => ok(c, await listTransfers(c.get("db"), c.req.valid("query"))));

adminTransferRoutes.openapi(createRoute({
  method: "post",
  path: "/",
  operationId: "dashboard.inventory_transfers.create",
  tags: [TAG],
  summary: "Create a draft transfer",
  description: `Between two different active locations; lines are live physical SKUs, each once, at most ${INVENTORY_TRANSFER_MAX_LINES}.`,
  request: { body: { content: { "application/json": { schema: createTransferSchema } } } },
  responses: {
    200: { description: "Draft created", content: { "application/json": { schema: transferEnvelope } } },
    400: errorResponses[400],
    404: errorResponses[404],
  },
}), async (c) => ok(c, await createTransfer(c.get("db"), c.req.valid("json"), c.get("user")?.id)));

adminTransferRoutes.openapi(createRoute({
  method: "get",
  path: "/{transferId}",
  operationId: "dashboard.inventory_transfers.get",
  tags: [TAG],
  summary: "Get a transfer with its lines and activity",
  request: { params: transferParams },
  responses: { 200: { description: "Transfer", content: { "application/json": { schema: transferEnvelope } } }, 404: errorResponses[404] },
}), async (c) => ok(c, await getTransfer(c.get("db"), c.req.valid("param").transferId)));

adminTransferRoutes.openapi(createRoute({
  method: "put",
  path: "/{transferId}",
  operationId: "dashboard.inventory_transfers.update",
  tags: [TAG],
  summary: "Edit a draft transfer",
  description: "Drafts only; sent lines replace its lines. expectedRevision must be current.",
  request: { params: transferParams, body: { content: { "application/json": { schema: updateTransferSchema } } } },
  responses: {
    200: { description: "Transfer saved", content: { "application/json": { schema: transferEnvelope } } },
    400: errorResponses[400],
    404: errorResponses[404],
    409: conflictResponse,
  },
}), async (c) => ok(c, await updateTransfer(c.get("db"), c.req.valid("param").transferId, c.req.valid("json"))));

adminTransferRoutes.openapi(createRoute({
  method: "post",
  path: "/{transferId}/ship",
  operationId: "dashboard.inventory_transfers.ship",
  tags: [TAG],
  summary: "Ship a transfer",
  description: "Every line leaves the origin in one atomic write (ledger `transfer_out` movements). Units in transit are out of both locations and of the SKU's stock, so buyers cannot buy them. Refused before writing when the origin lacks a line's units or they are committed to orders.",
  request: { params: transferParams, headers: idempotencyHeaders, body: { content: { "application/json": { schema: keyBody.merge(revisionBody) } } } },
  responses: {
    200: { description: "Transfer shipped", content: { "application/json": { schema: successEnvelope(transferCommandSchema) } } },
    400: errorResponses[400],
    404: errorResponses[404],
    409: conflictResponse,
  },
}), async (c) => {
  const { operationKey, expectedRevision } = c.req.valid("json");
  const key = operationKeyFrom(c.req.valid("header")["idempotency-key"], operationKey);
  return ok(c, await shipTransfer(c.get("db"), c.req.valid("param").transferId, { operationKey: key, expectedRevision }, c.get("user")?.id));
});

adminTransferRoutes.openapi(createRoute({
  method: "post",
  path: "/{transferId}/receive",
  operationId: "dashboard.inventory_transfers.receive",
  tags: [TAG],
  summary: "Receive units of a transfer",
  description: "Books some or all in-transit units at the destination (ledger `transfer_in` movements) in one atomic write.",
  request: {
    params: transferParams,
    headers: idempotencyHeaders,
    body: {
      content: {
        "application/json": {
          schema: keyBody.extend({
            lines: z.array(z.object({
              lineId: z.string().trim().min(1).max(100),
              quantity: z.number().int().min(1).max(1_000_000),
            })).min(1).max(INVENTORY_TRANSFER_MAX_LINES),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Units received", content: { "application/json": { schema: successEnvelope(transferCommandSchema) } } },
    400: errorResponses[400],
    404: errorResponses[404],
    409: conflictResponse,
  },
}), async (c) => {
  const { operationKey, lines } = c.req.valid("json");
  const key = operationKeyFrom(c.req.valid("header")["idempotency-key"], operationKey);
  return ok(c, await receiveTransfer(c.get("db"), c.req.valid("param").transferId, { operationKey: key, lines }, c.get("user")?.id));
});

adminTransferRoutes.openapi(createRoute({
  method: "post",
  path: "/{transferId}/cancel",
  operationId: "dashboard.inventory_transfers.cancel",
  tags: [TAG],
  summary: "Cancel a transfer",
  description: "A draft just closes. One in transit returns every unit still on the road to the origin (ledger `transfer_in` there) in one atomic write.",
  request: { params: transferParams, headers: idempotencyHeaders, body: { content: { "application/json": { schema: keyBody.merge(revisionBody) } } } },
  responses: {
    200: { description: "Transfer cancelled", content: { "application/json": { schema: successEnvelope(transferCommandSchema) } } },
    400: errorResponses[400],
    404: errorResponses[404],
    409: conflictResponse,
  },
}), async (c) => {
  const { operationKey, expectedRevision } = c.req.valid("json");
  const key = operationKeyFrom(c.req.valid("header")["idempotency-key"], operationKey);
  return ok(c, await cancelTransfer(c.get("db"), c.req.valid("param").transferId, { operationKey: key, expectedRevision }, c.get("user")?.id));
});

adminTransferRoutes.openapi(createRoute({
  method: "delete",
  path: "/{transferId}",
  operationId: "dashboard.inventory_transfers.delete",
  tags: [TAG],
  summary: "Delete a draft transfer",
  request: { params: transferParams, query: z.object({ expectedRevision: z.coerce.number().int().min(1) }) },
  responses: {
    200: { description: "Draft deleted", content: { "application/json": { schema: successEnvelope(z.object({ id: z.string(), deleted: z.literal(true) })) } } },
    404: errorResponses[404],
    409: conflictResponse,
  },
}), async (c) => ok(c, await deleteTransfer(c.get("db"), c.req.valid("param").transferId, c.req.valid("query").expectedRevision)));
