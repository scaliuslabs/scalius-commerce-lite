// Admin OpenAPI routes for webhook endpoints (COMMERCE-HOOKS H3): list,
// create (the signing secret is returned once), edit, enable/disable, delete,
// rotate the secret, send a test, and the per-endpoint delivery log.
// RBAC: `webhooks.view` / `webhooks.manage` (route-permissions/webhooks.ts).

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  DELIVERY_LIST_MAX_LIMIT,
  MAX_WEBHOOK_SUBSCRIPTIONS,
  WEBHOOK_DESCRIPTION_MAX_LENGTH,
  createWebhookSubscription,
  deleteWebhookSubscription,
  getWebhookSubscription,
  listWebhookDeliveries,
  listWebhookSubscriptions,
  retryWebhookDelivery,
  rotateWebhookSecret,
  sendWebhookTest,
  updateWebhookSubscription,
  type WebhookDeliveryView,
  type WebhookSubscriptionView,
} from "@scalius/core/modules/events";
import { WEBHOOK_DELIVERY_STATUSES } from "@scalius/database/schema";
import { EVENTS_API_VERSION, EVENT_TOPIC_FILTERS } from "@scalius/shared/events";
import { OUTBOUND_URL_MAX_LENGTH } from "@scalius/shared/outbound-url";
import { PROTECTED_CUSTOMER_DATA } from "@scalius/shared/plugins/protected-data";
import { created, ok } from "../../utils/api-response";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import { conflictResponse, errorResponses, serviceUnavailableResponse, successEnvelope } from "../../schemas/responses";
import { afterResponse, executionContextOf } from "../../background/after-response";

const app = new OpenAPIHono<{ Bindings: Env }>();

const isoOrNull = (seconds: number | null) => (seconds === null ? null : new Date(seconds * 1000).toISOString());
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

const topicFilterSchema = z.enum(EVENT_TOPIC_FILTERS as unknown as [string, ...string[]]).openapi({
  description: "An exact topic, `<resource>.*` for all of a resource's topics, or `*` for every topic.",
});

const customerDataSchema = z.array(z.enum(PROTECTED_CUSTOMER_DATA)).max(PROTECTED_CUSTOMER_DATA.length).openapi({
  description: "The buyer contact data deliveries include: names, emails, phones, street addresses. The rest read null; none by default.",
});

const webhookSubscriptionSchema = z.object({
  id: z.string(),
  url: z.string(),
  topics: z.array(z.string()),
  apiVersion: z.string(),
  customerData: customerDataSchema,
  description: z.string().nullable(),
  status: z.enum(["active", "disabled"]),
  disabledReason: z.enum(["manual", "failing"]).nullable(),
  disabledAt: z.string().nullable(),
  failureStreak: z.number().int(),
  failingSince: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastFailureAt: z.string().nullable(),
  secretHint: z.string().openapi({ description: "The secret's last four characters." }),
  version: z.number().int(),
  appId: z.string().nullable().openapi({ description: "The app that created it (it manages it through the app API); null for the store's own." }),
  createdAt: z.string(),
  updatedAt: z.string(),
}).openapi("WebhookSubscription");

const webhookDeliverySchema = z.object({
  id: z.string(),
  subscriptionId: z.string(),
  eventId: z.string().nullable(),
  kind: z.enum(["event", "test"]),
  topic: z.string(),
  resourceType: z.string().nullable(),
  resourceId: z.string().nullable(),
  status: z.enum(WEBHOOK_DELIVERY_STATUSES),
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  responseStatus: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  responseExcerpt: z.string().nullable().openapi({ description: "At most 256 characters of the response, masked." }),
  error: z.string().nullable(),
  nextAttemptAt: z.string().nullable(),
  lastAttemptAt: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  createdAt: z.string(),
}).openapi("WebhookDelivery");

function subscriptionResponse(view: WebhookSubscriptionView) {
  return {
    ...view,
    disabledAt: isoOrNull(view.disabledAt),
    failingSince: isoOrNull(view.failingSince),
    lastSuccessAt: isoOrNull(view.lastSuccessAt),
    lastFailureAt: isoOrNull(view.lastFailureAt),
    createdAt: iso(view.createdAt),
    updatedAt: iso(view.updatedAt),
  };
}

export function deliveryResponse(view: WebhookDeliveryView) {
  return {
    ...view,
    nextAttemptAt: isoOrNull(view.nextAttemptAt),
    lastAttemptAt: isoOrNull(view.lastAttemptAt),
    deliveredAt: isoOrNull(view.deliveredAt),
    createdAt: iso(view.createdAt),
  };
}

function noStore(c: { header(name: string, value: string): void }) {
  c.header("Cache-Control", "private, no-store");
}

const idParams = z.object({ id: z.string().min(1).max(64) });
const urlSchema = z.string().trim().min(1).max(OUTBOUND_URL_MAX_LENGTH).openapi({
  description: "HTTPS endpoint on a public host. Private, loopback, link-local and reserved addresses are refused.",
});
const topicsSchema = z.array(topicFilterSchema).min(1).max(EVENT_TOPIC_FILTERS.length);
const descriptionSchema = z.string().max(WEBHOOK_DESCRIPTION_MAX_LENGTH).nullable();

const mutationErrors = {
  400: errorResponses[400],
  401: errorResponses[401],
  403: errorResponses[403],
  404: errorResponses[404],
  409: conflictResponse,
  503: serviceUnavailableResponse,
} as const;

// ── List ──

const listRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "dashboard.webhooks.list",
  tags: ["Admin - Webhooks"],
  summary: "List webhook endpoints",
  responses: {
    200: {
      description: "Webhook endpoints and the event catalog they can subscribe to",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            subscriptions: z.array(webhookSubscriptionSchema).max(MAX_WEBHOOK_SUBSCRIPTIONS),
            maxSubscriptions: z.number().int(),
            apiVersion: z.string(),
            topicFilters: z.array(z.string()),
          })),
        },
      },
    },
    401: errorResponses[401],
    403: errorResponses[403],
  },
});

app.openapi(listRoute, async (c) => {
  noStore(c);
  const subscriptions = await listWebhookSubscriptions(c.get("db"));
  return ok(c, {
    subscriptions: subscriptions.map(subscriptionResponse),
    maxSubscriptions: MAX_WEBHOOK_SUBSCRIPTIONS,
    apiVersion: EVENTS_API_VERSION,
    topicFilters: [...EVENT_TOPIC_FILTERS],
  });
});

// ── Create ──

const createWebhookRoute = createRoute({
  method: "post",
  path: "/",
  operationId: "dashboard.webhooks.create",
  tags: ["Admin - Webhooks"],
  summary: "Create a webhook endpoint (returns its signing secret once)",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            url: urlSchema,
            topics: topicsSchema,
            description: descriptionSchema.optional(),
            customerData: customerDataSchema.optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Endpoint created. `secret` is shown only in this response.",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({ subscription: webhookSubscriptionSchema, secret: z.string() })),
        },
      },
    },
    ...mutationErrors,
  },
});

app.openapi(createWebhookRoute, async (c) => {
  noStore(c);
  const input = c.req.valid("json");
  // An agent acts for its owner; staff for themselves.
  const principal = c.get("agentPrincipal") as { ownerUserId?: string } | undefined;
  const user = c.get("user") as { id?: string } | undefined;
  const result = await createWebhookSubscription(c.get("db"), input, {
    actorId: principal?.ownerUserId ?? user?.id ?? null,
    encryptionKey: getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>),
  });
  return created(c, { subscription: subscriptionResponse(result.subscription), secret: result.secret });
});

// ── Get ──

const getWebhookRoute = createRoute({
  method: "get",
  path: "/{id}",
  operationId: "dashboard.webhooks.get",
  tags: ["Admin - Webhooks"],
  summary: "Get a webhook endpoint",
  request: { params: idParams },
  responses: {
    200: {
      description: "Webhook endpoint",
      content: { "application/json": { schema: successEnvelope(z.object({ subscription: webhookSubscriptionSchema })) } },
    },
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(getWebhookRoute, async (c) => {
  noStore(c);
  const subscription = await getWebhookSubscription(c.get("db"), c.req.valid("param").id);
  return ok(c, { subscription: subscriptionResponse(subscription) });
});

// ── Update / enable / disable ──

const updateWebhookRoute = createRoute({
  method: "patch",
  path: "/{id}",
  operationId: "dashboard.webhooks.update",
  tags: ["Admin - Webhooks"],
  summary: "Edit a webhook endpoint, or turn it on or off",
  description: "Turning an endpoint back on clears its failure streak. `expectedVersion` must be the endpoint's current version.",
  request: {
    params: idParams,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            expectedVersion: z.number().int().min(1),
            url: urlSchema.optional(),
            topics: topicsSchema.optional(),
            description: descriptionSchema.optional(),
            customerData: customerDataSchema.optional(),
            status: z.enum(["active", "disabled"]).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Endpoint saved",
      content: { "application/json": { schema: successEnvelope(z.object({ subscription: webhookSubscriptionSchema })) } },
    },
    ...mutationErrors,
  },
});

app.openapi(updateWebhookRoute, async (c) => {
  noStore(c);
  const subscription = await updateWebhookSubscription(c.get("db"), c.req.valid("param").id, c.req.valid("json"));
  return ok(c, { subscription: subscriptionResponse(subscription) });
});

// ── Delete ──

const deleteWebhookRoute = createRoute({
  method: "delete",
  path: "/{id}",
  operationId: "dashboard.webhooks.delete",
  tags: ["Admin - Webhooks"],
  summary: "Delete a webhook endpoint and its delivery log",
  request: { params: idParams },
  responses: {
    200: {
      description: "Endpoint deleted",
      content: { "application/json": { schema: successEnvelope(z.object({ id: z.string(), deleted: z.literal(true) })) } },
    },
    ...mutationErrors,
  },
});

app.openapi(deleteWebhookRoute, async (c) => {
  noStore(c);
  const { id } = c.req.valid("param");
  await deleteWebhookSubscription(c.get("db"), id);
  return ok(c, { id, deleted: true as const });
});

// ── Rotate secret ──

const rotateSecretRoute = createRoute({
  method: "post",
  path: "/{id}/rotate-secret",
  operationId: "dashboard.webhooks.rotate_secret",
  tags: ["Admin - Webhooks"],
  summary: "Replace a webhook's signing secret (returns the new secret once)",
  description: "The previous secret stops signing immediately.",
  request: { params: idParams },
  responses: {
    200: {
      description: "Secret rotated. `secret` is shown only in this response.",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({ subscription: webhookSubscriptionSchema, secret: z.string() })),
        },
      },
    },
    ...mutationErrors,
  },
});

app.openapi(rotateSecretRoute, async (c) => {
  noStore(c);
  const result = await rotateWebhookSecret(c.get("db"), c.req.valid("param").id, {
    encryptionKey: getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>),
  });
  return ok(c, { subscription: subscriptionResponse(result.subscription), secret: result.secret });
});

// ── Test ──

const testWebhookRoute = createRoute({
  method: "post",
  path: "/{id}/test",
  operationId: "dashboard.webhooks.test",
  tags: ["Admin - Webhooks"],
  summary: "Send a signed `webhook.test` delivery now",
  description: "One attempt, no retries; recorded in the delivery log and never counted against the endpoint's health.",
  request: {
    params: idParams,
    body: { required: true, content: { "application/json": { schema: z.object({}).strict() } } },
  },
  responses: {
    200: {
      description: "The test delivery's result",
      content: { "application/json": { schema: successEnvelope(z.object({ delivery: webhookDeliverySchema })) } },
    },
    ...mutationErrors,
  },
});

app.openapi(testWebhookRoute, async (c) => {
  noStore(c);
  const delivery = await sendWebhookTest(c.get("db"), c.req.valid("param").id, {
    encryptionKey: getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>),
  });
  return ok(c, { delivery: deliveryResponse(delivery) });
});

// ── Deliveries ──

const deliveriesRoute = createRoute({
  method: "get",
  path: "/{id}/deliveries",
  operationId: "dashboard.webhooks.deliveries_list",
  tags: ["Admin - Webhooks"],
  summary: "List a webhook endpoint's deliveries, newest first",
  request: {
    params: idParams,
    query: z.object({
      status: z.enum(WEBHOOK_DELIVERY_STATUSES).optional(),
      cursor: z.string().min(1).max(64).optional().openapi({ description: "`nextCursor` of the previous page." }),
      limit: z.coerce.number().int().min(1).max(DELIVERY_LIST_MAX_LIMIT).default(25),
    }),
  },
  responses: {
    200: {
      description: "Deliveries",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            deliveries: z.array(webhookDeliverySchema).max(DELIVERY_LIST_MAX_LIMIT),
            nextCursor: z.string().nullable(),
          })),
        },
      },
    },
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(deliveriesRoute, async (c) => {
  noStore(c);
  const query = c.req.valid("query");
  const page = await listWebhookDeliveries(c.get("db"), c.req.valid("param").id, query);
  return ok(c, { deliveries: page.deliveries.map(deliveryResponse), nextCursor: page.nextCursor });
});

const retryDeliveryRoute = createRoute({
  method: "post",
  path: "/{id}/deliveries/{deliveryId}/retry",
  operationId: "dashboard.webhooks.delivery_retry",
  tags: ["Admin - Webhooks"],
  summary: "Retry a failed, exhausted or cancelled delivery now",
  request: {
    params: z.object({ id: z.string().min(1).max(64), deliveryId: z.string().min(1).max(64) }),
  },
  responses: {
    200: {
      description: "The delivery, queued for a fresh retry cycle",
      content: { "application/json": { schema: successEnvelope(z.object({ delivery: webhookDeliverySchema })) } },
    },
    ...mutationErrors,
  },
});

app.openapi(retryDeliveryRoute, async (c) => {
  noStore(c);
  const { id, deliveryId } = c.req.valid("param");
  const db = c.get("db");
  const delivery = await retryWebhookDelivery(db, id, deliveryId);
  await afterResponse(c, "webhook retry", async () => {
    const { sendEventDeliveries } = await import("../../events/dispatch");
    await sendEventDeliveries(db, c.env, executionContextOf(c), [{ type: "webhooks.deliver", deliveryId }]);
  });
  return ok(c, { delivery: deliveryResponse(delivery) });
});

export { app as adminWebhookRoutes };
