// Warranty records in the stable app API (operation-registry/README.md),
// mounted at /admin/resources (COMMERCE-HOOKS H21). An order's records (the
// store's own warranty and every app's coverage), or an app's own records
// across the store, read under `read_orders` (`warranties.list`,
// `warranties.get`), as `warranty.issued` and `warranty.voided` deliveries
// carry them. The list pages in (updatedAt, id) order: a record's update is
// its issue or its void, through its own index for an app's store-wide list.
//
// An app that sells protection keeps no coverage store of its own: it issues
// the store's own warranty records for units of an order line under its plan
// (`warranties.issue`) and voids units' records when they are cancelled,
// refunded or returned (`warranties.void`), under `write_warranties`. Only an
// app issues and voids (staff and agents: 403 `app_principal_required`), and
// only its own records. Both set a target (the line holds `quantity` of the
// app's records; at least `quantity` of them are void), so a repeat with any
// key, or two events of one change, does nothing twice. Buyers claim the
// records through the store's warranty claims; staff move the claims.
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { and, eq, isNotNull, sql, type SQL } from "drizzle-orm";
import { orderItemWarranties } from "@scalius/database/schema";
import {
  APP_WARRANTY_UNITS_MAX,
  issueAppWarranties,
  readWarrantyRepresentations,
  voidAppWarranties,
} from "@scalius/core/modules/warranty";
import { keysetCondition } from "@scalius/core/utils/keyset";
import { EVENT_REPRESENTATION_SCHEMAS } from "@scalius/shared/events";
import type { ListCursorShape } from "@scalius/shared/pagination";
import { WARRANTY_DURATION_KINDS, WARRANTY_LIMITS } from "@scalius/shared/warranty";
import { adminRouter } from "./admin-router";
import { idempotencyKeyHeaderSchema } from "./idempotency";
import { requestAppId } from "./request-actor";
import { conflictResponse, errorResponses, namedSharedSchema, successEnvelope } from "../../schemas/responses";
import { nextCursorSchema } from "../../utils/bounded-page";
import { ok } from "../../utils/api-response";
import { AppError, NotFoundError, ValidationError } from "../../utils/api-error";
import { epochSeconds, keysetRowsPage, resourcePageQueryWith } from "../../utils/resource-page";

const app = adminRouter();

app.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "private, no-store");
});

const TAG = "App API - Warranties";
const WarrantyResource = namedSharedSchema(EVENT_REPRESENTATION_SCHEMAS.warranty, "WarrantyResource");
const idParam = z.object({ id: z.string().min(1).max(128) });
const readResponses = { 400: errorResponses[400], 401: errorResponses[401], 403: errorResponses[403], 404: errorResponses[404], 429: errorResponses[429], 500: errorResponses[500] };
const writeResponses = { ...errorResponses, 409: conflictResponse };

/** The calling app: coverage is issued and voided by apps only. */
function appIdOf(c: Context): string {
  const appId = requestAppId(c);
  if (!appId) throw new AppError(403, "app_principal_required", "Only an app issues and voids its coverage.");
  return appId;
}

const LIST_CURSOR: ListCursorShape = { sort: "updatedAt", direction: "asc", kinds: ["number"] };
/** A record changes when issued and when voided: its update is the later of the two. */
const UPDATED = sql`coalesce(${orderItemWarranties.voidedAt}, ${orderItemWarranties.createdAt})`;
const LIST_ORDER = { column: UPDATED, id: orderItemWarranties.id, direction: "asc" as const };
const WARRANTY_STATUSES = ["active", "expired", "voided"] as const;

app.openapi(createRoute({
  operationId: "dashboard.resources.warranties.list",
  method: "get",
  path: "/warranties",
  tags: [TAG],
  summary: "List warranty records: an order's, or the app's own across the store",
  description: "With orderId: the order's records, the store's own warranty (one per handed-over fulfilment line) and every app's coverage (one per unit). Without it: the calling app's own records across the store (another app's, and the store's own, are never listed; staff and agents name an orderId). In (updatedAt, id) order, a record's update being its issue or its void: start a sync with updatedSince and follow nextCursor. Narrow by orderItemId, status (`active`, `expired`, `voided`) and policyKey (the plan's key). Each record carries its order's number, its item, unit, code, start and end (null for lifetime) and its latest claim.",
  request: {
    query: z.object({
      ...resourcePageQueryWith(50, 50),
      orderId: z.string().min(1).max(80).optional().openapi({ description: "The order; leave it out to list the app's own records across the store." }),
      orderItemId: z.string().min(1).max(80).optional().openapi({ description: "Only this line's records." }),
      status: z.enum(WARRANTY_STATUSES).optional().openapi({ description: "`active`: not voided, lifetime or not yet ended; `expired`: a period that ended; `voided`." }),
      policyKey: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).optional().openapi({ description: "Only records of this plan (`warranties.issue` `policy.key`)." }),
    }),
  },
  responses: {
    200: { description: "A page of warranty records", content: { "application/json": { schema: successEnvelope(z.object({ warranties: z.array(WarrantyResource), nextCursor: nextCursorSchema })) } } },
    ...readResponses,
  },
}), async (c) => {
  const query = c.req.valid("query");
  const db = c.get("db");
  const where: SQL[] = [];
  if (query.orderId) {
    where.push(eq(orderItemWarranties.orderId, query.orderId));
  } else {
    // Store-wide, an app reads its own records only (through its own index).
    const appId = requestAppId(c);
    if (!appId) throw new ValidationError("Name an orderId: only an app lists its own records across the store.", { field: "orderId" });
    where.push(eq(orderItemWarranties.appId, appId));
  }
  if (query.orderItemId) where.push(eq(orderItemWarranties.orderItemId, query.orderItemId));
  const now = Math.floor(Date.now() / 1000);
  if (query.status === "voided") where.push(isNotNull(orderItemWarranties.voidedAt));
  else if (query.status === "active") where.push(sql`${orderItemWarranties.voidedAt} IS NULL AND (${orderItemWarranties.expiresAt} IS NULL OR ${orderItemWarranties.expiresAt} > ${now})`);
  else if (query.status === "expired") where.push(sql`${orderItemWarranties.voidedAt} IS NULL AND ${orderItemWarranties.expiresAt} <= ${now}`);
  if (query.policyKey) {
    const owner = query.orderId ? sql`` : sql` AND plan.app_id = ${requestAppId(c)}`;
    where.push(sql`${orderItemWarranties.revisionId} IN (SELECT plan_revision.id FROM warranty_policy_revisions AS plan_revision
      JOIN warranty_policies AS plan ON plan.id = plan_revision.policy_id WHERE plan.app_key = ${query.policyKey}${owner})`);
  }
  if (query.updatedSince) where.push(sql`${UPDATED} >= ${epochSeconds(query.updatedSince)}`);
  const page = await keysetRowsPage({
    shape: LIST_CURSOR,
    after: (cursor) => keysetCondition(LIST_ORDER, cursor),
    cursor: query.cursor,
    limit: query.limit,
    where,
    rows: (condition, limit) => db.select({ id: orderItemWarranties.id }).from(orderItemWarranties)
      .where(condition ?? and(...where)).orderBy(UPDATED, orderItemWarranties.id).limit(limit).all(),
    load: (rows) => readWarrantyRepresentations(db, rows.map((row) => row.id)),
    position: (warranty) => ({ values: [epochSeconds(warranty.updatedAt)], id: warranty.id }),
  });
  return ok(c, { warranties: page.items, nextCursor: page.nextCursor });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.warranties.get",
  method: "get",
  path: "/warranties/{id}",
  tags: [TAG],
  summary: "Get a warranty record",
  description: "One warranty record, as `warranty.issued` and `warranty.voided` deliveries carry it, with its latest claim.",
  request: { params: idParam },
  responses: {
    200: { description: "The warranty record", content: { "application/json": { schema: successEnvelope(z.object({ warranty: WarrantyResource })) } } },
    ...readResponses,
  },
}), async (c) => {
  const [warranty] = await readWarrantyRepresentations(c.get("db"), [c.req.valid("param").id]);
  if (!warranty) throw new NotFoundError("Warranty not found");
  return ok(c, { warranty });
});

const keyHeaders = z.object({
  "idempotency-key": idempotencyKeyHeaderSchema.shape["idempotency-key"].unwrap().openapi({
    description: "Required: a repeat answers the first call. The write sets a target, so another key repeating it changes nothing either.",
  }),
});
const linePage = (counted: string) => successEnvelope(z.object({
  warranties: z.array(WarrantyResource).max(APP_WARRANTY_UNITS_MAX).openapi({ description: "The line's records from this app, by unit." }),
  [counted]: z.number().int().min(0).openapi({ description: `Records this call ${counted}: 0 when the line already held the target.` }),
}));

const PlanInput = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).openapi({ description: "Your plan's key (`gold`, `lifetime`). A plan is one warranty policy of the app's: new terms under a key make its next revision; records keep the revision they were issued with." }),
  name: z.string().trim().min(1).max(WARRANTY_LIMITS.nameLength).openapi({ description: "What the buyer sees the cover as (`GameGhor Protection`)." }),
  durationUnit: z.enum(WARRANTY_DURATION_KINDS).openapi({ description: "days, months or years; lifetime: no end date, never expires." }),
  durationValue: z.number().int().min(WARRANTY_LIMITS.durationValue.min).max(WARRANTY_LIMITS.durationValue.max).nullable().optional()
    .openapi({ description: "1 to 120 days, months or years; leave it out (or null) for lifetime." }),
  terms: z.string().max(WARRANTY_LIMITS.termsLength).nullable().optional().openapi({ description: "Plain-text terms the buyer reads with the record." }),
}).strict();

app.openapi(createRoute({
  operationId: "dashboard.resources.warranties.issue",
  method: "post",
  path: "/warranties/issue",
  tags: [TAG],
  summary: "Cover units of an order line with the app's plan",
  description: "The line ends with `quantity` of this app's warranty records (voided ones count, so a unit refunded earlier is never covered again): each new one covers one unit, starts now, ends by the plan (never for lifetime) and gets a short buyer-facing `code` (8K4-XP2-MN9). Buyers see them in their account and on the order and claim them like any warranty. A repeat changes nothing. Refusals: warranty_line_not_coverable (a gift card), warranty_order_cancelled, validation_error (past the line's quantity, or an invalid plan), warranty_plan_conflict.",
  request: {
    headers: keyHeaders,
    body: {
      required: true,
      content: { "application/json": { schema: z.object({
        orderItemId: z.string().min(1).max(80).openapi({ description: "The order line." }),
        quantity: z.number().int().min(1).max(APP_WARRANTY_UNITS_MAX).openapi({ description: "The units of the line covered in all (at most its quantity)." }),
        policy: PlanInput,
      }).strict() } },
    },
  },
  responses: {
    200: { description: "The line's records from this app", content: { "application/json": { schema: linePage("issued") } } },
    ...writeResponses,
  },
}), async (c) => {
  const appId = appIdOf(c);
  const body = c.req.valid("json");
  const result = await issueAppWarranties(c.get("db"), {
    appId,
    orderItemId: body.orderItemId,
    quantity: body.quantity,
    plan: {
      key: body.policy.key,
      name: body.policy.name,
      durationUnit: body.policy.durationUnit,
      durationValue: body.policy.durationValue ?? null,
      terms: body.policy.terms ?? null,
    },
  });
  return ok(c, { warranties: result.warranties, issued: result.issued });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.warranties.void",
  method: "post",
  path: "/warranties/void",
  tags: [TAG],
  summary: "End the app's coverage of units of an order line",
  description: "At least `quantity` of this app's records on the line are void in all (count the units cancelled, refunded or returned from the order as it is now, so a refund and a return of the same unit void it once); the newest active units go first. A voided record takes no new claim; one already open stays with staff. A repeat changes nothing.",
  request: {
    headers: keyHeaders,
    body: {
      required: true,
      content: { "application/json": { schema: z.object({
        orderItemId: z.string().min(1).max(80).openapi({ description: "The order line." }),
        quantity: z.number().int().min(0).max(APP_WARRANTY_UNITS_MAX).openapi({ description: "The units of the line whose cover has ended in all." }),
      }).strict() } },
    },
  },
  responses: {
    200: { description: "The line's records from this app", content: { "application/json": { schema: linePage("voided") } } },
    ...writeResponses,
  },
}), async (c) => {
  const appId = appIdOf(c);
  const body = c.req.valid("json");
  const result = await voidAppWarranties(c.get("db"), { appId, orderItemId: body.orderItemId, quantity: body.quantity });
  return ok(c, { warranties: result.warranties, voided: result.voided });
});

export { app as adminResourceWarrantyRoutes };
