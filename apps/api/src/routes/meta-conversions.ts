// src/server/routes/meta-conversions.ts

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createId } from "@paralleldrive/cuid2";
import { sendCapiEvent } from "@scalius/core/integrations/meta/conversions-api";

import { ok } from "../utils/api-response";
const app = new OpenAPIHono<{ Bindings: Env }>();

const eventPayloadSchema = z.object({
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
    200: { description: "Event received and processing"  }
  }
});

app.openapi(postEventRoute, async (c) => {
  console.log("[Hono /meta/events] Received event request.");
  const body = c.req.valid("json");
  const eventId = createId();

  const db = c.get("db");

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
        c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
        c.req.header("x-real-ip"),
      client_user_agent:
        body.userData.client_user_agent || c.req.header("user-agent")
    },
    custom_data: body.customData
  });

  if (c.executionCtx && typeof c.executionCtx.waitUntil === 'function') {
    c.executionCtx.waitUntil(eventPromise);
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
