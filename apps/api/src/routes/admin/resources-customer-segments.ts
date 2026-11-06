// Saved customer segments in the stable app API (operation-registry/README.md),
// mounted at /admin/resources: the dashboard's segments
// (core customer-segments.ts) as one resource, `CustomerSegmentResource`,
// which every write answers (`{ segment }`). A segment is a saved filter over
// customers, evaluated live; its rules are `CustomerSegmentRules`, with
// spend in integer minor units of the store currency (`currency` beside
// them). Writes after create take the segment's `revision` as
// `expectedRevision` (a DELETE in its query). Members page by cursor in id
// order as customers carry them (`CustomerResource`, contact fields gated by
// the read_customer_* scopes). The dashboard's own segment routes, previews
// and counts stay `dashboard.customers.segments_*` (beta, money in major units).
import { createRoute, z } from "@hono/zod-openapi";
import { adminRouter } from "./admin-router";
import type { MiddlewareHandler } from "hono";
import { gte, isNull, type SQL } from "drizzle-orm";
import { customerSegments } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import {
  createCustomerSegment,
  deleteCustomerSegment,
  getCustomerSegment,
  getCustomerSegmentsByIds,
  listSegmentMemberIds,
  parseSegmentDefinition,
  updateCustomerSegment,
  type CustomerSegmentRecord,
} from "@scalius/core/modules/customers";
import { readStoreCurrency } from "@scalius/core/modules/markets";
import { keysetOrderBy, readListCursor } from "@scalius/core/utils/keyset";
import { EVENT_REPRESENTATION_SCHEMAS } from "@scalius/shared/events";
import {
  customerSegmentDefinitionAppSchema,
  segmentDefinitionFromApp,
  segmentDefinitionToApp,
  type CustomerSegmentDefinitionApp,
} from "@scalius/shared/customer-marketing";
import { encodeListCursorOrNull, type ListCursorShape } from "@scalius/shared/pagination";
import { created, ok } from "../../utils/api-response";
import { conflictResponse, errorResponses, namedSharedSchema, successEnvelope } from "../../schemas/responses";
import { isoTimestampSchema } from "../../schemas/timestamps";
import { nextCursorSchema } from "../../utils/bounded-page";
import { epochSeconds, resourcePage, resourcePageQuery, updatedOrder } from "../../utils/resource-page";
import { readCustomerRepresentations } from "../../events/representations";
import { idempotencyKeyHeaderSchema } from "./idempotency";

const app = adminRouter();

const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Cache-Control", "private, no-store");
};
app.use("*", noStore);

const CustomerResource = namedSharedSchema(EVENT_REPRESENTATION_SCHEMAS.customer, "CustomerResource");
const CustomerSegmentRules = namedSharedSchema(customerSegmentDefinitionAppSchema, "CustomerSegmentRules");

const CustomerSegmentResource = z.object({
  id: z.string(),
  name: z.string().openapi({ description: "1 to 80 characters, unique in the store (any case)." }),
  description: z.string().nullable(),
  /** Who is in it: up to 12 conditions, all or any of them. */
  definition: CustomerSegmentRules,
  currency: z.string().length(3).openapi({ description: "The store currency: `definition`'s spend (`amount_spent` minMinor and maxMinor) is in its integer minor units." }),
  revision: z.number().int().min(1).openapi({ description: "Send it as `expectedRevision` to change or delete the segment; every change advances it." }),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
}).openapi("CustomerSegmentResource");

type CustomerSegmentResourceData = z.infer<typeof CustomerSegmentResource>;

const idParam = z.object({ id: z.string().min(1).max(64) });
const segmentEnvelope = successEnvelope(z.object({ segment: CustomerSegmentResource }));
const readResponses = { 400: errorResponses[400], 401: errorResponses[401], 403: errorResponses[403], 404: errorResponses[404], 429: errorResponses[429], 500: errorResponses[500] };
const writeResponses = { ...errorResponses, 409: conflictResponse };

function segmentResource(record: CustomerSegmentRecord, currency: string): CustomerSegmentResourceData {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    definition: segmentDefinitionToApp(record.definition),
    currency,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

async function storeCurrency(db: Database): Promise<string> {
  return (await readStoreCurrency(db)).code;
}

/** Rules from the app API, as stored and checked against the store (its custom fields). */
function storedDefinition(db: Database, definition: CustomerSegmentDefinitionApp) {
  return parseSegmentDefinition(db, segmentDefinitionFromApp(definition));
}

app.openapi(createRoute({
  operationId: "dashboard.resources.customer_segments.list",
  method: "get",
  path: "/customer-segments",
  tags: ["App API - Customers"],
  summary: "List saved customer segments, least recently updated first",
  description: "The store's saved segments (at most 200) in (updatedAt, id) order, with their rules. Start a sync with updatedSince and follow nextCursor.",
  request: { query: z.object(resourcePageQuery) },
  responses: {
    200: { description: "A page of segments", content: { "application/json": { schema: successEnvelope(z.object({ segments: z.array(CustomerSegmentResource), nextCursor: nextCursorSchema })) } } },
    ...readResponses,
  },
}), async (c) => {
  const query = c.req.valid("query");
  const db = c.get("db");
  const where: SQL[] = [isNull(customerSegments.deletedAt)];
  if (query.updatedSince) where.push(gte(customerSegments.updatedAt, epochSeconds(query.updatedSince)));
  const order = updatedOrder(customerSegments.updatedAt, customerSegments.id);
  const currency = await storeCurrency(db);
  const page = await resourcePage({
    order,
    cursor: query.cursor,
    limit: query.limit,
    where,
    ids: (condition, limit) => db.select({ id: customerSegments.id }).from(customerSegments).where(condition).orderBy(...keysetOrderBy(order)).limit(limit).all(),
    load: async (ids) => (await getCustomerSegmentsByIds(db, ids)).map((record) => segmentResource(record, currency)),
  });
  return ok(c, { segments: page.items, nextCursor: page.nextCursor });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.customer_segments.get",
  method: "get",
  path: "/customer-segments/{id}",
  tags: ["App API - Customers"],
  summary: "Get a saved customer segment",
  description: "The segment's rules, with the revision to change it at.",
  request: { params: idParam },
  responses: {
    200: { description: "The segment", content: { "application/json": { schema: segmentEnvelope } } },
    ...readResponses,
  },
}), async (c) => {
  const db = c.get("db");
  return ok(c, { segment: segmentResource(await getCustomerSegment(db, c.req.valid("param").id), await storeCurrency(db)) });
});

const segmentBody = z.object({
  name: z.string().max(200).openapi({ description: "1 to 80 characters after trimming, unique in the store (any case)." }),
  description: z.string().max(600).nullable().optional().openapi({ description: "At most 300 characters after trimming; empty or null clears it." }),
  definition: CustomerSegmentRules,
}).strict();

app.openapi(createRoute({
  operationId: "dashboard.resources.customer_segments.create",
  method: "post",
  path: "/customer-segments",
  tags: ["App API - Customers"],
  summary: "Save a customer segment",
  description: "Saves a segment (a store keeps at most 200): a named filter over customers, evaluated live wherever it is used (discounts, price lists, campaigns). Spend is in minor units of the store currency. A name another segment has is refused with 409.",
  request: {
    headers: idempotencyKeyHeaderSchema,
    body: { required: true, content: { "application/json": { schema: segmentBody } } },
  },
  responses: {
    201: { description: "The segment", content: { "application/json": { schema: segmentEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  const db = c.get("db");
  const body = c.req.valid("json");
  const user = c.get("user") as { id?: string } | undefined;
  const record = await createCustomerSegment(db, {
    name: body.name,
    description: body.description,
    definition: await storedDefinition(db, body.definition),
  }, c.get("pluginPrincipal") ? null : user?.id ?? null);
  return created(c, { segment: segmentResource(record, await storeCurrency(db)) });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.customer_segments.update",
  method: "patch",
  path: "/customer-segments/{id}",
  tags: ["App API - Customers"],
  summary: "Change a saved customer segment",
  description: "Changes the fields sent (name, description, the whole rules) under the revision read; a segment changed since is refused with 409 and nothing changes.",
  request: {
    params: idParam,
    headers: idempotencyKeyHeaderSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: segmentBody.partial().extend({
            expectedRevision: z.number().int().min(1).openapi({ description: "The segment's `revision` you read." }),
          }).strict(),
        },
      },
    },
  },
  responses: {
    200: { description: "The segment", content: { "application/json": { schema: segmentEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  const db = c.get("db");
  const body = c.req.valid("json");
  const record = await updateCustomerSegment(db, c.req.valid("param").id, {
    expectedRevision: body.expectedRevision,
    name: body.name,
    description: body.description,
    definition: body.definition ? await storedDefinition(db, body.definition) : undefined,
  });
  return ok(c, { segment: segmentResource(record, await storeCurrency(db)) });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.customer_segments.delete",
  method: "delete",
  path: "/customer-segments/{id}",
  tags: ["App API - Customers"],
  summary: "Delete a saved customer segment",
  description: "Deletes the segment (no customer is deleted). Refused with 409 while a discount (not archived) or a price list uses it, or when it changed since the revision read.",
  request: {
    params: idParam,
    headers: idempotencyKeyHeaderSchema,
    query: z.object({
      expectedRevision: z.coerce.number().int().min(1).openapi({ description: "The segment's `revision` you read." }),
    }),
  },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: successEnvelope(z.object({ id: z.string(), deleted: z.literal(true) })) } } },
    ...writeResponses,
  },
}), async (c) => {
  const id = c.req.valid("param").id;
  await deleteCustomerSegment(c.get("db"), id, { expectedRevision: c.req.valid("query").expectedRevision });
  return ok(c, { id, deleted: true as const });
});

/** Members per page: customers as webhooks carry them, within the response budget. */
const MEMBERS_DEFAULT = 20;
const MEMBERS_MAX = 50;
const MEMBER_PAGE_BYTES = 56 * 1024;
/** A member cursor names the last customer only (an id; no contact data). */
const MEMBER_CURSOR: ListCursorShape = { sort: "id", direction: "asc", kinds: [] };

app.openapi(createRoute({
  operationId: "dashboard.resources.customer_segments.list_members",
  method: "get",
  path: "/customer-segments/{id}/members",
  tags: ["App API - Customers"],
  summary: "List a segment's members",
  description: "The customers in the segment now, in id order, as webhooks carry them (CustomerResource); follow nextCursor to walk the whole segment. Membership is evaluated live, so a customer who joins or leaves between pages may be missed or seen once. Contact fields read null without the matching read_customer_* scope.",
  request: {
    params: idParam,
    query: z.object({
      cursor: z.string().max(1024).optional().openapi({ description: "The `nextCursor` of the page before; leave it out for the first page." }),
      limit: z.coerce.number().int().min(1).max(MEMBERS_MAX).default(MEMBERS_DEFAULT)
        .openapi({ description: "At most this many customers; a page may hold fewer to stay within the response budget." }),
    }),
  },
  responses: {
    200: { description: "A page of members", content: { "application/json": { schema: successEnvelope(z.object({ customers: z.array(CustomerResource), nextCursor: nextCursorSchema })) } } },
    ...readResponses,
  },
}), async (c) => {
  const db = c.get("db");
  const query = c.req.valid("query");
  const segment = await getCustomerSegment(db, c.req.valid("param").id);
  const afterId = query.cursor ? readListCursor(query.cursor, MEMBER_CURSOR).id : null;
  const ids = await listSegmentMemberIds(db, segment.definition, { afterId, limit: query.limit + 1 });
  const more = ids.length > query.limit;
  const loaded = await readCustomerRepresentations(db, ids.slice(0, query.limit));
  const kept: typeof loaded = [];
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const customer of loaded) {
    const size = encoder.encode(JSON.stringify(customer)).byteLength + 1;
    if (kept.length > 0 && bytes + size > MEMBER_PAGE_BYTES) break;
    kept.push(customer);
    bytes += size;
  }
  const last = kept.at(-1);
  const nextCursor = (more || kept.length < loaded.length) && last
    ? encodeListCursorOrNull({ sort: MEMBER_CURSOR.sort, direction: "asc", values: [], id: last.id })
    : null;
  return ok(c, { customers: kept, nextCursor });
});

export { app as adminResourceCustomerSegmentRoutes };
