// The signed-in buyer's Web Push (packages/plugin-sdk/docs/apps.md, "Push"): the
// VAPID key the account page subscribes with, whether this browser is
// subscribed, and subscribe and unsubscribe. Order notifications and apps
// (`ctx.messaging.pushCustomer`) send to these browsers.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  deletePushSubscription,
  hasPushSubscription,
  parsePushSubscription,
  savePushSubscription,
  webPushPublicKey,
  webPushSender,
} from "@scalius/core/modules/notifications";
import { errorResponses, successEnvelope } from "../../schemas/responses";
import { ok } from "../../utils/api-response";
import { UnauthorizedError } from "../../utils/api-error";
import { requireCustomerSession } from "./shared";

const app = new OpenAPIHono<{ Bindings: Env }>();

async function accountId(c: Parameters<typeof requireCustomerSession>[0]): Promise<string> {
  const { session } = await requireCustomerSession(c);
  if (!session.customerId) throw new UnauthorizedError("Session expired. Please log in again.");
  return session.customerId;
}

const stateSchema = z.object({
  publicKey: z.string().nullable(),
  /** The store can send (a master secret and an https store or dashboard address). */
  available: z.boolean(),
  /** This browser (the `endpoint` asked about) is subscribed to this account. */
  subscribed: z.boolean(),
});

app.openapi(createRoute({
  method: "post",
  path: "/push/state",
  operationId: "storefront.customer_auth_push.state",
  tags: ["Customer Auth"],
  summary: "Web Push for this account and browser",
  description: "POST so the browser's endpoint stays out of URLs and logs.",
  request: { body: { required: true, content: { "application/json": { schema: z.object({ endpoint: z.string().max(2048).optional() }).strict() } } } },
  responses: {
    200: { description: "Web Push state", content: { "application/json": { schema: successEnvelope(stateSchema) } } },
    ...errorResponses,
  },
}), async (c) => {
  c.header("Cache-Control", "private, no-store");
  const customerId = await accountId(c);
  const { endpoint } = c.req.valid("json");
  const [publicKey, sender, subscribed] = await Promise.all([
    webPushPublicKey(c.env),
    webPushSender(c.env),
    endpoint ? hasPushSubscription(c.get("db"), { audience: "customer", customerId }, endpoint) : Promise.resolve(false),
  ]);
  return ok(c, { publicKey, available: Boolean(publicKey && sender), subscribed });
});

app.openapi(createRoute({
  method: "post",
  path: "/push/subscribe",
  operationId: "storefront.customer_auth_push.subscribe",
  tags: ["Customer Auth"],
  summary: "Get this account's notifications in this browser",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            endpoint: z.string().max(2048),
            keys: z.object({ p256dh: z.string().max(120), auth: z.string().max(40) }),
            deviceLabel: z.string().max(200).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Subscribed", content: { "application/json": { schema: successEnvelope(z.object({ subscribed: z.literal(true) })) } } },
    ...errorResponses,
  },
}), async (c) => {
  const customerId = await accountId(c);
  await savePushSubscription(c.get("db"), { audience: "customer", customerId }, parsePushSubscription(c.req.valid("json")));
  return ok(c, { subscribed: true as const });
});

app.openapi(createRoute({
  method: "post",
  path: "/push/unsubscribe",
  operationId: "storefront.customer_auth_push.unsubscribe",
  tags: ["Customer Auth"],
  summary: "Stop this account's notifications in this browser",
  request: { body: { required: true, content: { "application/json": { schema: z.object({ endpoint: z.string().max(2048) }).strict() } } } },
  responses: {
    200: { description: "Unsubscribed", content: { "application/json": { schema: successEnvelope(z.object({ subscribed: z.literal(false) })) } } },
    ...errorResponses,
  },
}), async (c) => {
  const customerId = await accountId(c);
  await deletePushSubscription(c.get("db"), { audience: "customer", customerId }, c.req.valid("json").endpoint);
  return ok(c, { subscribed: false as const });
});

export { app as customerPushRoutes };
