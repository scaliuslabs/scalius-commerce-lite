// An app's own webhook subscriptions in the stable app API
// (operation-registry/README.md), mounted at /admin/resources. Only an app
// calls them, under `write_webhooks`, and only ever reaches the subscriptions
// it created: the store's other endpoints stay staff-only
// (`dashboard.webhooks.*`, internal). An app's endpoint must be on one of its
// approved hosts, for event topics and customer data its grant covers; each
// delivery re-checks that grant (plugins/webhook-access.ts), and uninstalling
// the app deletes its subscriptions. Deliveries are signed like every webhook
// (COMMERCE-HOOKS H3); the secret is returned once, at create.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  MAX_APP_WEBHOOK_SUBSCRIPTIONS,
  WEBHOOK_DESCRIPTION_MAX_LENGTH,
  createWebhookSubscription,
  deleteWebhookSubscription,
  listWebhookSubscriptions,
  updateWebhookSubscription,
  type WebhookOwner,
  type WebhookSubscriptionView,
} from "@scalius/core/modules/events";
import { EVENTS_API_VERSION, EVENT_TOPIC_FILTERS } from "@scalius/shared/events";
import { OUTBOUND_URL_MAX_LENGTH } from "@scalius/shared/outbound-url";
import { PROTECTED_CUSTOMER_DATA } from "@scalius/shared/plugins/protected-data";
import { AppError } from "@scalius/core/errors";
import { created, ok } from "../../utils/api-response";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import { conflictResponse, errorResponses, successEnvelope } from "../../schemas/responses";
import { idempotencyKeyHeaderSchema } from "./idempotency";
import { readAppWebhookAccess } from "../../plugins/webhook-access";

const app = new OpenAPIHono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "private, no-store");
});

const isoOrNull = (seconds: number | null) => (seconds === null ? null : new Date(seconds * 1000).toISOString());

const topicFilter = z.enum(EVENT_TOPIC_FILTERS as unknown as [string, ...string[]]).openapi({
  description: "An exact topic, `<resource>.*` for all of a resource's topics, or `*`; the app's grant must cover it (its manifest `events`).",
});
const customerData = z.array(z.enum(PROTECTED_CUSTOMER_DATA)).max(PROTECTED_CUSTOMER_DATA.length).openapi({
  description: "The buyer contact data deliveries include, within the app's protected data scopes; the rest read null. None by default.",
});

const AppWebhookSubscription = z.object({
  id: z.string(),
  url: z.string(),
  topics: z.array(z.string()),
  apiVersion: z.string().openapi({ description: "The payload version deliveries use." }),
  customerData: z.array(z.enum(PROTECTED_CUSTOMER_DATA)),
  description: z.string().nullable(),
  status: z.enum(["active", "disabled"]),
  disabledReason: z.enum(["manual", "failing"]).nullable().openapi({ description: "`failing`: sustained delivery failure turned it off." }),
  failureStreak: z.number().int(),
  failingSince: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastFailureAt: z.string().nullable(),
  secretHint: z.string().openapi({ description: "The signing secret's last four characters." }),
  version: z.number().int().positive().openapi({ description: "Send it as `expectedVersion` to change or delete it." }),
  createdAt: z.string(),
  updatedAt: z.string(),
}).openapi("AppWebhookSubscription");

function subscriptionResource(view: WebhookSubscriptionView): z.infer<typeof AppWebhookSubscription> {
  return {
    id: view.id,
    url: view.url,
    topics: view.topics,
    apiVersion: view.apiVersion,
    customerData: view.customerData,
    description: view.description,
    status: view.status,
    disabledReason: view.disabledReason,
    failureStreak: view.failureStreak,
    failingSince: isoOrNull(view.failingSince),
    lastSuccessAt: isoOrNull(view.lastSuccessAt),
    lastFailureAt: isoOrNull(view.lastFailureAt),
    secretHint: view.secretHint,
    version: view.version,
    createdAt: new Date(view.createdAt * 1000).toISOString(),
    updatedAt: new Date(view.updatedAt * 1000).toISOString(),
  };
}

/** The calling app and its live grant; staff and agents manage webhooks through dashboard.webhooks.*. */
async function appOwner(c: Context): Promise<WebhookOwner> {
  const principal = c.get("pluginPrincipal") as { pluginId: string } | undefined;
  if (!principal) {
    throw new AppError(403, "app_principal_required", "Only an app manages its own webhook subscriptions here. Staff use Settings → Webhooks.");
  }
  const access = await readAppWebhookAccess(c.get("db"), principal.pluginId);
  if (!access) throw new AppError(403, "app_scope_required", "The app needs the write_webhooks scope, approved and active.");
  return { pluginId: principal.pluginId, access };
}

const url = z.string().trim().min(1).max(OUTBOUND_URL_MAX_LENGTH).openapi({
  description: "HTTPS endpoint on one of the app's approved hosts (`allowedHosts`). Private, loopback and reserved addresses are refused.",
});
const topics = z.array(topicFilter).min(1).max(EVENT_TOPIC_FILTERS.length);
const description = z.string().max(WEBHOOK_DESCRIPTION_MAX_LENGTH).nullable();
const subscriptionId = z.object({ id: z.string().min(1).max(64) });
const expectedVersion = z.number().int().positive().openapi({ description: "The subscription's `version` you read; a stale one is refused with 409." });
const subscriptionEnvelope = successEnvelope(z.object({ subscription: AppWebhookSubscription }));
const writeResponses = { ...errorResponses, 409: conflictResponse };

app.openapi(createRoute({
  operationId: "dashboard.resources.webhook_subscriptions.list",
  method: "get",
  path: "/webhook-subscriptions",
  tags: ["App API - Webhooks"],
  summary: "List the app's own webhook subscriptions",
  description: "Only the calling app's subscriptions, with their health. The store's other webhooks are never visible.",
  responses: {
    200: {
      description: "The app's subscriptions",
      content: { "application/json": { schema: successEnvelope(z.object({
        subscriptions: z.array(AppWebhookSubscription).max(MAX_APP_WEBHOOK_SUBSCRIPTIONS),
        maxSubscriptions: z.number().int().openapi({ description: "How many one app may keep." }),
        apiVersion: z.string(),
      })) } },
    },
    ...errorResponses,
  },
}), async (c) => {
  const owner = await appOwner(c);
  const subscriptions = await listWebhookSubscriptions(c.get("db"), owner);
  return ok(c, {
    subscriptions: subscriptions.map(subscriptionResource),
    maxSubscriptions: MAX_APP_WEBHOOK_SUBSCRIPTIONS,
    apiVersion: EVENTS_API_VERSION,
  });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.webhook_subscriptions.create",
  method: "post",
  path: "/webhook-subscriptions",
  tags: ["App API - Webhooks"],
  summary: "Subscribe one of the app's endpoints to store events",
  description: "Deliveries are signed with the returned `secret`, shown only in this response: keep it to verify them. A repeat with the same Idempotency-Key is refused (409 idempotency_secret_not_replayed): the secret is never stored to replay.",
  request: {
    headers: idempotencyKeyHeaderSchema,
    body: {
      required: true,
      content: { "application/json": { schema: z.object({
        url,
        topics,
        description: description.optional(),
        customerData: customerData.optional(),
      }).strict() } },
    },
  },
  responses: {
    201: {
      description: "The subscription and its signing secret (shown once)",
      content: { "application/json": { schema: successEnvelope(z.object({ subscription: AppWebhookSubscription, secret: z.string() })) } },
    },
    ...writeResponses,
  },
}), async (c) => {
  const owner = await appOwner(c);
  c.set("idempotencySecretResponse", true);
  const result = await createWebhookSubscription(c.get("db"), c.req.valid("json"), {
    actorId: (c.get("user") as { id?: string } | undefined)?.id ?? null,
    encryptionKey: getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>),
    owner,
  });
  return created(c, { subscription: subscriptionResource(result.subscription), secret: result.secret });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.webhook_subscriptions.update",
  method: "patch",
  path: "/webhook-subscriptions/{id}",
  tags: ["App API - Webhooks"],
  summary: "Edit, pause or resume one of the app's webhook subscriptions",
  description: "Fields left out keep their value. `status: active` turns it back on and clears its failure streak.",
  request: {
    params: subscriptionId,
    body: {
      required: true,
      content: { "application/json": { schema: z.object({
        expectedVersion,
        url: url.optional(),
        topics: topics.optional(),
        description: description.optional(),
        customerData: customerData.optional(),
        status: z.enum(["active", "disabled"]).optional(),
      }).strict() } },
    },
  },
  responses: {
    200: { description: "The subscription", content: { "application/json": { schema: subscriptionEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  const owner = await appOwner(c);
  const subscription = await updateWebhookSubscription(c.get("db"), c.req.valid("param").id, c.req.valid("json"), owner);
  return ok(c, { subscription: subscriptionResource(subscription) });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.webhook_subscriptions.delete",
  method: "delete",
  path: "/webhook-subscriptions/{id}",
  tags: ["App API - Webhooks"],
  summary: "Delete one of the app's webhook subscriptions and its delivery log",
  request: {
    params: subscriptionId,
    query: z.object({ expectedVersion: z.coerce.number().int().positive() }),
  },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: successEnvelope(z.object({ id: z.string(), deleted: z.literal(true) })) } } },
    ...writeResponses,
  },
}), async (c) => {
  const owner = await appOwner(c);
  const { id } = c.req.valid("param");
  await deleteWebhookSubscription(c.get("db"), id, owner, c.req.valid("query").expectedVersion);
  return ok(c, { id, deleted: true as const });
});

export { app as adminResourceWebhookRoutes };
