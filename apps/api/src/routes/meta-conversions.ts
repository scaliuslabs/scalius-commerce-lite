// src/server/routes/meta-conversions.ts

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createId } from "@paralleldrive/cuid2";
import { sendCapiEvent } from "@scalius/core/integrations/meta/conversions-api";
import { getClientIp, rateLimit } from "@scalius/shared/rate-limit";

import { ok } from "../utils/api-response";
import { errorResponses, successEnvelope } from "../schemas/responses";
import { RateLimitError, ValidationError } from "../utils/api-error";
import { getEncryptionKey } from "../utils/encryption-key";
const app = new OpenAPIHono<{ Bindings: Env }>();

const eventPayloadSchema = z.object({
  eventId: z.string().min(8).max(128).optional(),
  eventName: z.enum([
    "ViewContent",
    "Search",
    "AddToCart",
    "InitiateCheckout",
    "AddPaymentInfo",
    "Purchase",
    "Lead",
    "CompleteRegistration",
  ]),
  eventSourceUrl: z.url(),
  actionSource: z
    .enum([
      "website",
      "app",
      "offline",
      "chat",
      "physical_store",
      "system_generated",
      "business_messaging",
      "other",
    ])
    .optional()
    .default("website"),
  userData: z
    .object({
      em: z.email().optional(),
      ph: z.string().optional(),
      client_ip_address: z.string().optional(),
      client_user_agent: z.string().optional(),
      fbp: z.string().optional(),
      fbc: z.string().optional(),
      external_id: z.union([z.string(), z.array(z.string())]).optional(),
      fn: z.string().optional(),
      ln: z.string().optional(),
      ge: z.enum(["f", "m"]).optional(),
      db: z.string().optional(),
      ct: z.string().optional(),
      st: z.string().optional(),
      zp: z.string().optional(),
      country: z.string().optional(),
      subscription_id: z.string().optional(),
      lead_id: z.coerce.number().optional()
    })
    .passthrough(),
  customData: z
    .object({
      value: z.number().optional(),
      currency: z.string().optional(),
      content_ids: z.array(z.string()).optional(),
      contents: z
        .array(
          z.object({
            id: z.string(),
            quantity: z.number(),
            item_price: z.number().optional()
          }),
        )
        .optional(),
      content_type: z.enum(["product", "product_group"]).optional(),
      order_id: z.string().optional(),
      search_string: z.string().optional()
    })
    .passthrough()
    .optional()
});

function isTrustedEventSource(eventSourceUrl: string, storefrontUrl?: string): boolean {
  if (!storefrontUrl) {
    return true;
  }

  try {
    return new URL(eventSourceUrl).origin === new URL(storefrontUrl).origin;
  } catch {
    return false;
  }
}

function getOptionalExecutionContext(c: { executionCtx?: ExecutionContext }): ExecutionContext | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

// ─── POST /events ────────────────────────────────────────────────────────────

const postEventRoute = createRoute({
  method: "post",
  path: "/events",
  tags: ["Meta Conversions"],
  summary: "Send a Meta Conversions API event",
  request: {
    body: {
      content: {
        "application/json": { schema: eventPayloadSchema }
      }
    }
  },
  responses: {
    200: {
      description: "Event received and processing",
      content: { "application/json": { schema: successEnvelope(z.object({
        message: z.string(),
        eventId: z.string(),
      })) } },
    },
    400: errorResponses[400],
    429: errorResponses[429],
    500: errorResponses[500],
  }
});

app.openapi(postEventRoute, async (c) => {
  console.log("[Hono /meta/events] Received event request.");
  const body = c.req.valid("json");
  const eventId = body.eventId ?? createId();

  if (!isTrustedEventSource(body.eventSourceUrl, c.env.STOREFRONT_URL)) {
    throw new ValidationError("Event source URL is not trusted for this storefront.");
  }

  const kv = c.env.CACHE as KVNamespace | undefined;
  if (kv) {
    const ip = getClientIp(c.req.raw);
    const result = await rateLimit({
      kv,
      key: `meta-events:${ip}`,
      limit: 120,
      windowMs: 60_000,
    });
    if (!result.allowed) {
      throw new RateLimitError("Too many tracking events. Please try again later.");
    }
  }

  const db = c.get("db");
  const clientIp = getClientIp(c.req.raw);
  const clientIpForMeta =
    clientIp === "unknown" ? c.req.header("x-real-ip") : clientIp;

  const eventPromise = sendCapiEvent(db, {
    event_name: body.eventName,
    event_time: Math.floor(Date.now() / 1000),
    event_source_url: body.eventSourceUrl,
    event_id: eventId,
    action_source: body.actionSource,
    user_data: {
      ...body.userData,
      client_ip_address:
        body.userData.client_ip_address ||
        clientIpForMeta,
      client_user_agent:
        body.userData.client_user_agent || c.req.header("user-agent")
    },
    custom_data: body.customData
  }, {
    encryptionKey: getEncryptionKey(c.env as unknown as Record<string, unknown>),
  });

  const executionCtx = getOptionalExecutionContext(c);
  if (executionCtx && typeof executionCtx.waitUntil === "function") {
    executionCtx.waitUntil(eventPromise);
    console.log("[Hono /meta/events] Event processing scheduled with waitUntil.");
  } else {
    console.warn("[Hono /meta/events] c.executionCtx.waitUntil not available. Awaiting promise directly.");
    await eventPromise;
  }

  return ok(c, {
    message: "Event received and is being processed.",
    eventId: eventId
  });
});

export { app as metaConversionsRoutes };
