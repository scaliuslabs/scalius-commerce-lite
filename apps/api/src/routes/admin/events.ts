// Admin OpenAPI route for the store event log (COMMERCE-HOOKS H3): the recent
// rows of the event outbox, newest first, with their thin facts. RBAC:
// `webhooks.view` (route-permissions/webhooks.ts).

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { EVENT_LIST_MAX_LIMIT, listRecentEvents } from "@scalius/core/modules/events";
import { EVENT_RESOURCE_TYPES, EVENT_TOPICS } from "@scalius/shared/events";
import { ok } from "../../utils/api-response";
import { errorResponses, successEnvelope } from "../../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();

const eventSummarySchema = z.object({
  id: z.string(),
  topic: z.string(),
  apiVersion: z.string(),
  resourceType: z.string(),
  resourceId: z.string(),
  facts: z.record(z.string(), z.unknown()).openapi({ description: "Thin facts written with the event: ids, from/to states, quantities." }),
  occurredAt: z.string(),
  status: z.string(),
  attempts: z.number().int(),
  dispatchedAt: z.string().nullable(),
}).openapi("StoreEvent");

const listRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "dashboard.events.list",
  tags: ["Admin - Webhooks"],
  summary: "List recent store events, newest first",
  request: {
    query: z.object({
      topic: z.enum(EVENT_TOPICS).optional(),
      resourceType: z.enum(EVENT_RESOURCE_TYPES).optional(),
      resourceId: z.string().min(1).max(128).optional(),
      cursor: z.string().min(1).max(64).optional().openapi({ description: "`nextCursor` of the previous page." }),
      limit: z.coerce.number().int().min(1).max(EVENT_LIST_MAX_LIMIT).default(25),
    }),
  },
  responses: {
    200: {
      description: "Recent events",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            events: z.array(eventSummarySchema).max(EVENT_LIST_MAX_LIMIT),
            nextCursor: z.string().nullable(),
          })),
        },
      },
    },
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
  },
});

app.openapi(listRoute, async (c) => {
  c.header("Cache-Control", "private, no-store");
  const page = await listRecentEvents(c.get("db"), c.req.valid("query"));
  return ok(c, {
    events: page.events.map((event) => ({
      ...event,
      occurredAt: new Date(event.occurredAt * 1000).toISOString(),
      dispatchedAt: event.dispatchedAt === null ? null : new Date(event.dispatchedAt * 1000).toISOString(),
    })),
    nextCursor: page.nextCursor,
  });
});

export { app as adminEventRoutes };
