// Digital goods in the stable app API (operation-registry/README.md), mounted
// at /admin/resources: a product's files and licence-key pools
// (`digital_assets.*`, read with the catalog), and a buyer's access to them
// (`digital_access.*`: an order line's entitlements, given and taken away
// with the order edit the dashboard's reset and revoke need).
//
// Nothing secret leaves here: no storage key, signed URL, download ticket or
// licence key, only a pool's key counts. A grant runs the core grant
// (`fulfilment/digital-access.ts`): an owed line is handed over by the
// order's automatic fulfilment, so stock and licence keys move through the
// same ledger rows as the automatic delivery. Grants and revokes set a target
// state per line and asset, so a repeat (any key, even after a lost response)
// grants or revokes nothing twice.
//
// An entitlement has no revision: its download count moves on every buyer
// download, so a revision would refuse a revoke racing a download. A revoke
// sets the target state and answers it.
import { createRoute, z } from "@hono/zod-openapi";
import { adminRouter } from "./admin-router";
import type { MiddlewareHandler } from "hono";
import { eq, gte, isNull, sql, type SQL } from "drizzle-orm";
import { digitalAssets, digitalEntitlements, orders } from "@scalius/database/schema";
import { keysetOrderBy } from "@scalius/core/utils/keyset";
import {
  readDigitalAccessViews,
  readDigitalAssetViews,
  revokeDigitalEntitlement,
  type DigitalAccessView,
  type DigitalAssetView,
} from "@scalius/core/modules/digital";
import { grantDigitalAccess } from "@scalius/core/modules/fulfilment";
import { DIGITAL_ACCESS_STATUSES, DIGITAL_ASSET_KINDS, digitalAccessStatus } from "@scalius/shared/digital";
import { ok } from "../../utils/api-response";
import { NotFoundError, ValidationError } from "../../utils/api-error";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import { conflictResponse, errorResponses, successEnvelope } from "../../schemas/responses";
import { isoTimestampSchema } from "../../schemas/timestamps";
import { nextCursorSchema } from "../../utils/bounded-page";
import { epochSeconds, resourcePage, resourcePageQuery, updatedOrder } from "../../utils/resource-page";
import { afterResponse } from "../../background/after-response";
import { idempotencyKeyHeaderSchema } from "./idempotency";

const app = adminRouter();

const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Cache-Control", "private, no-store");
};
app.use("*", noStore);

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const isoOrNull = (seconds: number | null) => (seconds === null ? null : iso(seconds));

const DigitalAssetResource = z.object({
  id: z.string(),
  productId: z.string(),
  variantId: z.string().nullable().openapi({ description: "Null: a file every digital variant of the product delivers. A licence-key pool always names its variant." }),
  kind: z.enum(DIGITAL_ASSET_KINDS).openapi({ description: "`file`: a download. `licence_keys`: a pool of keys, which is its variant's stock." }),
  status: z.enum(["draft", "ready", "archived"]).openapi({ description: "`draft` until its file is uploaded; only `ready` items are delivered; `archived` ones go to no new order." }),
  name: z.string().openapi({ description: "What the buyer sees it as." }),
  filename: z.string().nullable().openapi({ description: "The file's download name; null for a key pool." }),
  contentType: z.string().nullable().openapi({ description: "The file's media type; null for a key pool." }),
  sizeBytes: z.number().int().nullable().openapi({ description: "The uploaded file's size; null before upload and for a key pool." }),
  downloadLimit: z.number().int().nullable().openapi({ description: "Downloads each buyer gets (1 to 100), or null for unlimited. Delivery snapshots it." }),
  accessDays: z.number().int().nullable().openapi({ description: "Days of access after delivery (1 to 3650), or null for forever. Delivery snapshots it." }),
  licenceKeys: z.object({
    available: z.number().int().openapi({ description: "Keys not assigned yet (the variant's stock)." }),
    assigned: z.number().int().openapi({ description: "Keys handed over to buyers." }),
  }).nullable().openapi({ description: "A key pool's counts; null for a file. Key values never leave the store." }),
  revision: z.number().int().positive().openapi({ description: "Advances when the item's settings or file change." }),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
}).openapi("DigitalAssetResource");

const DigitalAccessResource = z.object({
  id: z.string(),
  orderId: z.string(),
  orderItemId: z.string(),
  assetId: z.string(),
  productId: z.string(),
  variantId: z.string().nullable().openapi({ description: "The order line's SKU." }),
  customerId: z.string().nullable().openapi({ description: "The order's customer, if any." }),
  kind: z.enum(DIGITAL_ASSET_KINDS),
  name: z.string().openapi({ description: "The digital item's name." }),
  quantity: z.number().int().openapi({ description: "Licence keys assigned to the line; 1 for a file." }),
  downloadCount: z.number().int().openapi({ description: "Downloads used (files)." }),
  downloadLimit: z.number().int().nullable().openapi({ description: "Downloads allowed, or null for unlimited; keys have none." }),
  expiresAt: isoTimestampSchema.nullable().openapi({ description: "When file access ends, or null for never." }),
  revokedAt: isoTimestampSchema.nullable().openapi({ description: "When the store removed the access, or null." }),
  lastDownloadAt: isoTimestampSchema.nullable(),
  status: z.enum(DIGITAL_ACCESS_STATUSES).openapi({
    description: "`active`; `exhausted`: every download used; `expired`: its access days ran out; `ended`: the order was cancelled, refunded or returned; `revoked`: the store removed it.",
  }),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
}).openapi("DigitalAccessResource");

type DigitalAssetResourceValue = z.infer<typeof DigitalAssetResource>;
type DigitalAccessResourceValue = z.infer<typeof DigitalAccessResource>;

function assetResource(asset: DigitalAssetView): DigitalAssetResourceValue {
  return {
    id: asset.id,
    productId: asset.productId,
    variantId: asset.variantId,
    kind: asset.kind,
    status: asset.status,
    name: asset.displayName,
    filename: asset.filename,
    contentType: asset.mediaType,
    sizeBytes: asset.hasFile ? asset.sizeBytes : null,
    downloadLimit: asset.downloadLimit,
    accessDays: asset.accessDays,
    licenceKeys: asset.kind === "licence_keys" ? { available: asset.keys.available, assigned: asset.keys.assigned } : null,
    revision: asset.version,
    createdAt: iso(asset.createdAt),
    updatedAt: iso(asset.updatedAt),
  };
}

function accessResource(access: DigitalAccessView, now: number): DigitalAccessResourceValue {
  return {
    id: access.id,
    orderId: access.orderId,
    orderItemId: access.orderItemId,
    assetId: access.assetId,
    productId: access.productId,
    variantId: access.variantId,
    customerId: access.customerId,
    kind: access.kind,
    name: access.name,
    quantity: access.quantity,
    downloadCount: access.downloadCount,
    downloadLimit: access.downloadLimit,
    expiresAt: isoOrNull(access.expiresAt),
    revokedAt: isoOrNull(access.revokedAt),
    lastDownloadAt: isoOrNull(access.lastDownloadAt),
    status: digitalAccessStatus(access, now),
    createdAt: iso(access.createdAt),
    updatedAt: iso(access.updatedAt),
  };
}

async function readAccessResource(db: Parameters<typeof readDigitalAccessViews>[0], id: string): Promise<DigitalAccessResourceValue> {
  const [access] = await readDigitalAccessViews(db, [id]);
  if (!access) throw new NotFoundError("Digital access not found");
  return accessResource(access, Math.floor(Date.now() / 1000));
}

const readResponses = { 400: errorResponses[400], 401: errorResponses[401], 403: errorResponses[403], 404: errorResponses[404], 429: errorResponses[429], 500: errorResponses[500] };
const writeResponses = { ...errorResponses, 409: conflictResponse };
const idParam = z.object({ id: z.string().min(1).max(80) });
const assetEnvelope = successEnvelope(z.object({ digitalAsset: DigitalAssetResource }));

app.openapi(createRoute({
  operationId: "dashboard.resources.digital_assets.list",
  method: "get",
  path: "/digital-assets",
  tags: ["App API - Digital goods"],
  summary: "List digital files and licence-key pools, least recently updated first",
  description: "Every product's downloadable files and licence-key pools (archived ones too), in (updatedAt, id) order: narrow to one product with productId, start a sync with updatedSince and follow nextCursor. A pool answers its key counts; no storage key, link or key value is ever returned.",
  request: {
    query: z.object({
      ...resourcePageQuery,
      productId: z.string().min(1).max(80).optional().openapi({ description: "Only this product's files and pools." }),
    }),
  },
  responses: {
    200: {
      description: "A page of digital items",
      content: { "application/json": { schema: successEnvelope(z.object({ digitalAssets: z.array(DigitalAssetResource), nextCursor: nextCursorSchema })) } },
    },
    ...readResponses,
  },
}), async (c) => {
  const query = c.req.valid("query");
  const db = c.get("db");
  const where: SQL[] = [];
  if (query.productId) where.push(eq(digitalAssets.productId, query.productId));
  if (query.updatedSince) where.push(gte(sql`${digitalAssets.updatedAt}`, epochSeconds(query.updatedSince)));
  const order = updatedOrder(digitalAssets.updatedAt, digitalAssets.id);
  const page = await resourcePage({
    order,
    cursor: query.cursor,
    limit: query.limit,
    where,
    ids: (condition, limit) => db.select({ id: digitalAssets.id }).from(digitalAssets).where(condition).orderBy(...keysetOrderBy(order)).limit(limit).all(),
    load: async (ids) => (await readDigitalAssetViews(db, ids)).map(assetResource),
  });
  return ok(c, { digitalAssets: page.items, nextCursor: page.nextCursor });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.digital_assets.get",
  method: "get",
  path: "/digital-assets/{id}",
  tags: ["App API - Digital goods"],
  summary: "Get a digital file or licence-key pool",
  request: { params: idParam },
  responses: {
    200: { description: "The digital item", content: { "application/json": { schema: assetEnvelope } } },
    ...readResponses,
  },
}), async (c) => {
  const [asset] = await readDigitalAssetViews(c.get("db"), [c.req.valid("param").id]);
  if (!asset) throw new NotFoundError("Digital item not found");
  return ok(c, { digitalAsset: assetResource(asset) });
});

const accessEnvelope = (receipt: z.ZodRawShape) => successEnvelope(z.object({ entitlement: DigitalAccessResource, ...receipt }));

app.openapi(createRoute({
  operationId: "dashboard.resources.digital_access.list",
  method: "get",
  path: "/digital-access",
  tags: ["App API - Digital goods"],
  summary: "List what an order or a customer's orders give access to",
  description: "One entitlement per order line and digital item (a file, or the line's licence keys, which are never returned), with its downloads, expiry and status, in (updatedAt, id) order. Name an orderId, a customerId (the order's customer) or both; follow nextCursor.",
  request: {
    query: z.object({
      ...resourcePageQuery,
      orderId: z.string().min(1).max(80).optional().openapi({ description: "Only this order's access." }),
      customerId: z.string().min(1).max(80).optional().openapi({ description: "Only access given by this customer's orders." }),
    }),
  },
  responses: {
    200: {
      description: "A page of access records",
      content: { "application/json": { schema: successEnvelope(z.object({ entitlements: z.array(DigitalAccessResource), nextCursor: nextCursorSchema })) } },
    },
    ...readResponses,
  },
}), async (c) => {
  const query = c.req.valid("query");
  if (!query.orderId && !query.customerId) throw new ValidationError("Name an orderId or a customerId.", { field: "orderId" });
  const db = c.get("db");
  const where: SQL[] = [isNull(orders.deletedAt)];
  if (query.orderId) where.push(eq(digitalEntitlements.orderId, query.orderId));
  if (query.customerId) where.push(eq(orders.customerId, query.customerId));
  if (query.updatedSince) where.push(gte(sql`${digitalEntitlements.updatedAt}`, epochSeconds(query.updatedSince)));
  const order = updatedOrder(digitalEntitlements.updatedAt, digitalEntitlements.id);
  const now = Math.floor(Date.now() / 1000);
  const page = await resourcePage({
    order,
    cursor: query.cursor,
    limit: query.limit,
    where,
    ids: (condition, limit) => db.select({ id: digitalEntitlements.id }).from(digitalEntitlements)
      .innerJoin(orders, eq(orders.id, digitalEntitlements.orderId))
      .where(condition).orderBy(...keysetOrderBy(order)).limit(limit).all(),
    load: async (ids) => (await readDigitalAccessViews(db, ids)).map((access) => accessResource(access, now)),
  });
  return ok(c, { entitlements: page.items, nextCursor: page.nextCursor });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.digital_access.grant",
  method: "post",
  path: "/digital-access",
  tags: ["App API - Digital goods"],
  summary: "Give a buyer access to a digital item on their order line",
  description: "For a paid order's line whose product delivers the item: a line still owed is handed over as the store's automatic delivery would (with the delivery message, and any other automatic line the order owes), a revoked access is given back, and a file added after delivery is issued. `outcome` says which; a repeat grants nothing twice. Refusals: digital_access_order_unpaid, digital_access_order_closed, digital_access_order_on_hold, digital_access_awaiting_confirmation, digital_asset_not_on_line, digital_asset_not_ready, digital_keys_exhausted, digital_access_keys_not_owed, digital_access_nothing_owed. Send an Idempotency-Key.",
  request: {
    headers: z.object({
      "idempotency-key": idempotencyKeyHeaderSchema.shape["idempotency-key"].unwrap().openapi({
        description: "Required: a repeat answers the first grant.",
      }),
    }),
    body: {
      required: true,
      content: { "application/json": { schema: z.object({
        orderId: z.string().min(1).max(80),
        orderItemId: z.string().min(1).max(80).openapi({ description: "The order line that bought the item." }),
        assetId: z.string().min(1).max(80).openapi({ description: "The digital item (digital_assets.list) the line's product delivers." }),
      }).strict() } },
    },
  },
  responses: {
    200: {
      description: "The buyer's access",
      content: { "application/json": { schema: accessEnvelope({
        outcome: z.enum(["issued", "reinstated", "unchanged"]).openapi({ description: "`issued`: new access. `reinstated`: revoked access given back. `unchanged`: the buyer already had it." }),
      }) } },
    },
    ...writeResponses,
  },
}), async (c) => {
  const db = c.get("db");
  const result = await grantDigitalAccess(db, c.req.valid("json"), {
    credentialEncryptionKey: getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>),
  });
  if (result.outcome === "issued") {
    // The delivery message the handover queued goes out now; the sweep retries what this misses.
    await afterResponse(c, "digital access grant", async () => {
      const { drainNotificationOutbox } = await import("../../background/notifications");
      await drainNotificationOutbox(db, c.env);
    });
  }
  return ok(c, { entitlement: await readAccessResource(db, result.entitlementId), outcome: result.outcome });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.digital_access.revoke",
  method: "post",
  path: "/digital-access/{id}/revoke",
  tags: ["App API - Digital goods"],
  summary: "Take a buyer's access to a digital item away",
  description: "Downloads and licence-key reveals stop at once; assigned keys stay assigned (a key is never handed out again). Revoking revoked access changes nothing (`outcome: unchanged`); digital_access.grant gives it back. Send an Idempotency-Key.",
  request: { params: idParam },
  responses: {
    200: {
      description: "The buyer's access",
      content: { "application/json": { schema: accessEnvelope({
        outcome: z.enum(["revoked", "unchanged"]).openapi({ description: "`unchanged`: it was already revoked." }),
      }) } },
    },
    ...writeResponses,
  },
}), async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const before = await readAccessResource(db, id);
  if (before.revokedAt !== null) return ok(c, { entitlement: before, outcome: "unchanged" as const });
  await revokeDigitalEntitlement(db, id);
  return ok(c, { entitlement: await readAccessResource(db, id), outcome: "revoked" as const });
});

export { app as adminResourceDigitalRoutes };
