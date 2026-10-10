// Staff Web Push (docs/platform/PLUGINS.md, "Push"), mounted at
// /admin/web-push: the VAPID public key a dashboard browser subscribes
// with, the signed-in staff member's own browsers, and subscribe and
// unsubscribe. Every staff member manages only their own browsers. A staff
// push (new order, a staff alert, an app's `notifyStaff`) goes to Firebase
// devices and these browsers alike.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  deletePushSubscription,
  deleteStaffPushDevice,
  listStaffPushDevices,
  parsePushSubscription,
  savePushSubscription,
  sendStaffTestPush,
  webPushPublicKey,
  webPushSender,
} from "@scalius/core/modules/notifications";
import { NotFoundError, RateLimitError, ServiceUnavailableError, UnauthorizedError } from "../../utils/api-error";
import { isWithinRateLimit } from "../../utils/rate-limit";
import { noContent, ok } from "../../utils/api-response";
import { errorResponses, noContentResponse, successEnvelope } from "../../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();
const TAG = "Admin - Web Push";

function staffId(c: Context): string {
  const user = (c as unknown as { get(key: "user"): { id?: string } | undefined }).get("user");
  if (!user?.id) throw new UnauthorizedError("Unauthorized");
  return user.id;
}

const subscriptionBody = z.object({
  endpoint: z.string().max(2048),
  keys: z.object({ p256dh: z.string().max(120), auth: z.string().max(40) }),
  deviceLabel: z.string().max(200).optional(),
}).openapi("WebPushSubscription", { description: "The browser's `PushSubscription.toJSON()`, with a short device label." });

const deviceSchema = z.object({
  id: z.string(),
  deviceLabel: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  createdAt: z.string(),
  failureCount: z.number().int().openapi({ description: "Sends that failed in a row since the last delivery; 0 when the last one arrived." }),
});

app.openapi(createRoute({
  operationId: "dashboard.web_push.get",
  method: "get",
  path: "/",
  tags: [TAG],
  summary: "Web Push for this staff member",
  description: "The VAPID public key browsers subscribe with, whether this Worker can send (a master secret and an https dashboard address), and the browsers this staff member subscribed.",
  responses: {
    200: {
      description: "Web Push state",
      content: { "application/json": { schema: successEnvelope(z.object({
        publicKey: z.string().nullable(),
        available: z.boolean(),
        devices: z.array(deviceSchema),
      })) } },
    },
    ...errorResponses,
  },
}), async (c) => {
  c.header("Cache-Control", "private, no-store");
  const [publicKey, sender, devices] = await Promise.all([
    webPushPublicKey(c.env),
    webPushSender(c.env),
    listStaffPushDevices(c.get("db"), staffId(c)),
  ]);
  return ok(c, {
    publicKey,
    available: Boolean(publicKey && sender),
    devices: devices.map((device) => ({
      id: device.id,
      deviceLabel: device.deviceLabel,
      lastSuccessAt: device.lastSuccessAt?.toISOString() ?? null,
      createdAt: device.createdAt.toISOString(),
      failureCount: device.failureCount,
    })),
  });
});

app.openapi(createRoute({
  operationId: "dashboard.web_push.device_test",
  method: "post",
  path: "/devices/{id}/test",
  tags: [TAG],
  summary: "Send a test notification to one of this staff member's browsers",
  description: "Sends the text given (the dashboard's language) to one of the caller's own browsers at once and records the delivery like any send. `sent` means the push service accepted it; the browser shows it within seconds when it is online. Five tests a minute per staff member.",
  request: {
    params: z.object({ id: z.string().min(1).max(68) }),
    body: { required: true, content: { "application/json": { schema: z.object({
      title: z.string().trim().min(1).max(120),
      body: z.string().trim().max(240),
    }) } } },
  },
  responses: {
    200: {
      description: "What the push service answered",
      content: { "application/json": { schema: successEnvelope(z.object({
        outcome: z.enum(["sent", "failed", "gone"]).openapi({ description: "`gone`: the browser dropped the subscription, so it was removed." }),
      })) } },
    },
    ...errorResponses,
  },
}), async (c) => {
  c.header("Cache-Control", "private, no-store");
  const userId = staffId(c);
  if (!(await isWithinRateLimit(c.env, "RL_STRICT", "web_push_test", userId))) {
    throw new RateLimitError("Too many test notifications. Try again in a minute.");
  }
  const sender = await webPushSender(c.env);
  if (!sender) throw new ServiceUnavailableError("Browser notifications need your store's https web address.");
  const { title, body } = c.req.valid("json");
  const outcome = await sendStaffTestPush(c.get("db"), sender, userId, c.req.valid("param").id, { title, body });
  if (outcome === null) throw new NotFoundError("Device not found");
  return ok(c, { outcome: outcome === "sent" ? "sent" as const : outcome === "gone" ? "gone" as const : "failed" as const });
});

app.openapi(createRoute({
  operationId: "dashboard.web_push.subscribe",
  method: "post",
  path: "/subscriptions",
  tags: [TAG],
  summary: "Subscribe this browser to staff notifications",
  request: { body: { required: true, content: { "application/json": { schema: subscriptionBody } } } },
  responses: {
    200: { description: "Subscribed", content: { "application/json": { schema: successEnvelope(z.object({ id: z.string() })) } } },
    ...errorResponses,
  },
}), async (c) => {
  const saved = await savePushSubscription(c.get("db"), { audience: "staff", userId: staffId(c) }, parsePushSubscription(c.req.valid("json")));
  return ok(c, saved);
});

app.openapi(createRoute({
  operationId: "dashboard.web_push.unsubscribe",
  method: "post",
  path: "/subscriptions/remove",
  tags: [TAG],
  summary: "Unsubscribe this browser",
  request: { body: { required: true, content: { "application/json": { schema: z.object({ endpoint: z.string().max(2048) }) } } } },
  responses: { 204: noContentResponse, ...errorResponses },
}), async (c) => {
  await deletePushSubscription(c.get("db"), { audience: "staff", userId: staffId(c) }, c.req.valid("json").endpoint);
  return noContent(c);
});

app.openapi(createRoute({
  operationId: "dashboard.web_push.device_delete",
  method: "delete",
  path: "/devices/{id}",
  tags: [TAG],
  summary: "Remove one of this staff member's browsers",
  request: { params: z.object({ id: z.string().min(1).max(68) }) },
  responses: { 204: noContentResponse, ...errorResponses },
}), async (c) => {
  if (!(await deleteStaffPushDevice(c.get("db"), staffId(c), c.req.valid("param").id))) throw new NotFoundError("Device not found");
  return noContent(c);
});

export { app as adminWebPushRoutes };
