// Warranty records in the stable app API (operation-registry/README.md),
// mounted at /admin/resources (COMMERCE-HOOKS H21). An order's records, the
// store's own warranty and every app's coverage, read under `read_orders`
// (`warranties.list`, `warranties.get`), as `warranty.issued` and
// `warranty.voided` deliveries carry them.
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
import { and, eq, type SQL } from "drizzle-orm";
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
import { AppError, NotFoundError } from "../../utils/api-error";
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

const LIST_CURSOR: ListCursorShape = { sort: "createdAt", direction: "asc", kinds: ["number"] };
const LIST_ORDER = { column: orderItemWarranties.createdAt, id: orderItemWarranties.id, direction: "asc" as const };

app.openapi(createRoute({
  operationId: "dashboard.resources.warranties.list",
  method: "get",
  path: "/warranties",
  tags: [TAG],
  summary: "List an order's warranty records, oldest first",
  description: "The store's own warranty records of the order (one per handed-over fulfilment line) and every app's coverage (one per unit), in (createdAt, id) order, with each one's latest claim. Narrow to one line with orderItemId; follow nextCursor.",
  request: {
    query: z.object({
      cursor: resourcePageQueryWith(50, 50).cursor,
      limit: resourcePageQueryWith(50, 50).limit,
      orderId: z.string().min(1).max(80).openapi({ description: "The order." }),
      orderItemId: z.string().min(1).max(80).optional().openapi({ description: "Only this line's records." }),
    }),
  },
  responses: {
    200: { description: "A page of warranty records", content: { "application/json": { schema: successEnvelope(z.object({ warranties: z.array(WarrantyResource), nextCursor: nextCursorSchema })) } } },
    ...readResponses,
  },
}), async (c) => {
  const query = c.req.valid("query");
  const db = c.get("db");
  const where: SQL[] = [eq(orderItemWarranties.orderId, query.orderId)];
  if (query.orderItemId) where.push(eq(orderItemWarranties.orderItemId, query.orderItemId));
  const page = await keysetRowsPage({
    shape: LIST_CURSOR,
    after: (cursor) => keysetCondition(LIST_ORDER, cursor),
    cursor: query.cursor,
    limit: query.limit,
    where,
    rows: (condition, limit) => db.select({ id: orderItemWarranties.id }).from(orderItemWarranties)
      .where(condition ?? and(...where)).orderBy(orderItemWarranties.createdAt, orderItemWarranties.id).limit(limit).all(),
    load: (rows) => readWarrantyRepresentations(db, rows.map((row) => row.id)),
    position: (warranty) => ({ values: [epochSeconds(warranty.createdAt)], id: warranty.id }),
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
