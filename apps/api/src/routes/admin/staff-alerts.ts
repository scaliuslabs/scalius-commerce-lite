// Private caller-owned bell. Core rechecks current resource permissions in every read/write.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  STAFF_ALERT_COUNT_CAP,
  STAFF_ALERT_KINDS,
  STAFF_ALERT_MAX_PAGE_SIZE,
  STAFF_ALERT_PAGE_SIZE,
  STAFF_ALERT_SCOPES,
  clearStaffAlerts,
  markAllStaffAlertsRead,
  markStaffAlertRead,
  readStaffAlertSummary,
  readStaffAlerts,
  undoStaffAlertsClear,
} from "@scalius/core/modules/notifications";
import { UnauthorizedError } from "../../utils/api-error";
import { ok } from "../../utils/api-response";
import { conflictResponse, errorResponses, successEnvelope } from "../../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();
const TAG = "Admin - Staff Alerts";
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const scope = z.enum(STAFF_ALERT_SCOPES);
const scopeRevision = z.object({ scope, revision: integer }).strict();
const scopeRevisions = z.array(scopeRevision).min(1).max(STAFF_ALERT_SCOPES.length)
  .refine((items) => new Set(items.map((item) => item.scope)).size === items.length, "Scopes must be unique");
const operationId = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);
const summary = z.object({
  head: integer,
  unreadCount: z.number().int().min(0).max(STAFF_ALERT_COUNT_CAP),
  unreadCountCapped: z.boolean(),
  countCap: z.literal(STAFF_ALERT_COUNT_CAP),
  scopes: z.array(scopeRevision.extend({ readThrough: integer, clearedThrough: integer })).max(STAFF_ALERT_SCOPES.length),
}).openapi("StaffAlertSummary");
const undoBody = z.object({ operationId, scopes: scopeRevisions }).strict().openapi("StaffAlertUndo");
const mutation = z.object({ summary, undo: undoBody.optional() }).openapi("StaffAlertMutation");
const page = summary.extend({
  items: z.array(z.object({
    seq: integer.min(1),
    id: z.string(),
    scope,
    kind: z.enum(STAFF_ALERT_KINDS),
    subjectId: z.string(),
    occurredAt: z.string().datetime(),
    orderNumber: z.string().nullable(),
    read: z.boolean(),
    href: z.string(),
  })).max(STAFF_ALERT_MAX_PAGE_SIZE),
  nextBefore: integer.min(1).nullable(),
}).openapi("StaffAlertPage");
const mutationResponses = {
  200: { description: "Updated caller-owned bell state", content: { "application/json": { schema: successEnvelope(mutation) } } },
  ...errorResponses,
  409: conflictResponse,
};

function staffId(c: Context<{ Bindings: Env }>): string {
  const user = c.get("user") as { id?: string } | undefined;
  if (!user?.id) throw new UnauthorizedError("Sign in again to view notifications.");
  return user.id;
}

// Also covers validation failures and missing identity in route-level consumers/tests.
app.use("*", async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  staffId(c);
  await next();
});

app.openapi(createRoute({
  operationId: "dashboard.notifications.feed",
  method: "get", path: "/", tags: [TAG],
  summary: "List the signed-in staff member's notifications",
  description: "Newest delivery sequence first. Current resource permissions filter every read. Clear all dismisses notifications without deleting history. Unread counts are capped at 99; unreadCountCapped means more than 99.",
  request: { query: z.object({
    beforeSeq: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    limit: z.coerce.number().int().min(1).max(STAFF_ALERT_MAX_PAGE_SIZE).default(STAFF_ALERT_PAGE_SIZE),
  }).strict() },
  responses: {
    200: { description: "Bounded caller-owned page", content: { "application/json": { schema: successEnvelope(page) } } },
    ...errorResponses,
  },
}), async (c) => ok(c, await readStaffAlerts(c.get("db"), staffId(c), c.req.valid("query"))));

app.openapi(createRoute({
  operationId: "dashboard.notifications.summary",
  method: "get", path: "/summary", tags: [TAG],
  summary: "Read the caller's notification frontier and capped unread count",
  responses: {
    200: { description: "Caller-owned summary", content: { "application/json": { schema: successEnvelope(summary) } } },
    ...errorResponses,
  },
}), async (c) => ok(c, await readStaffAlertSummary(c.get("db"), staffId(c))));

app.openapi(createRoute({
  operationId: "dashboard.notifications.read",
  method: "post", path: "/{seq}/read", tags: [TAG],
  summary: "Mark one accessible notification as read",
  request: { params: z.object({ seq: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }) },
  responses: mutationResponses,
}), async (c) => ok(c, await markStaffAlertRead(c.get("db"), staffId(c), c.req.valid("param").seq)));

app.openapi(createRoute({
  operationId: "dashboard.notifications.read_all",
  method: "post", path: "/read-all", tags: [TAG],
  summary: "Mark the displayed notification frontier as read",
  description: "Only the requested scopes still authorized for the caller change. Alerts appended after the observed frontier remain unread.",
  request: { body: { required: true, content: { "application/json": { schema: z.object({
    through: integer,
    scopes: z.array(scope).min(1).max(STAFF_ALERT_SCOPES.length)
      .refine((items) => new Set(items).size === items.length, "Scopes must be unique"),
  }).strict() } } } },
  responses: mutationResponses,
}), async (c) => ok(c, await markAllStaffAlertsRead(c.get("db"), staffId(c), c.req.valid("json"))));

app.openapi(createRoute({
  operationId: "dashboard.notifications.clear_all",
  method: "post", path: "/clear-all", tags: [TAG],
  summary: "Dismiss and mark read notifications through the displayed frontier",
  description: "No history is deleted. Reuse operationId for retries of the same click. Every requested scope must remain authorized and match its revision; any conflict returns 409 without partial changes. The result supplies the exact input for Undo.",
  request: { body: { required: true, content: { "application/json": { schema: z.object({
    operationId, through: integer, scopes: scopeRevisions,
  }).strict() } } } },
  responses: mutationResponses,
}), async (c) => ok(c, await clearStaffAlerts(c.get("db"), staffId(c), c.req.valid("json"))));

app.openapi(createRoute({
  operationId: "dashboard.notifications.undo_clear_all",
  method: "post", path: "/clear-all/undo", tags: [TAG],
  summary: "Undo the caller's most recent matching Clear all",
  description: "Restores only saved frontiers. Individual read receipts and later alerts survive. A changed revision, operation or permission returns 409 for the whole request without partial changes.",
  request: { body: { required: true, content: { "application/json": { schema: undoBody } } } },
  responses: mutationResponses,
}), async (c) => ok(c, await undoStaffAlertsClear(c.get("db"), staffId(c), c.req.valid("json"))));

export { app as adminStaffAlertRoutes };
