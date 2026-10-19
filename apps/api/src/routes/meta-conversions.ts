// src/server/routes/meta-conversions.ts

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createId } from "@paralleldrive/cuid2";
import {
  sendCapiEvent,
} from "@scalius/core/integrations/meta/conversions-api";
import { getClientIp } from "@scalius/shared/rate-limit";

import { ok } from "../utils/api-response";
import { errorResponses, successEnvelope } from "../schemas/responses";
import { RateLimitError, ValidationError } from "../utils/api-error";
import { getCredentialEncryptionKey } from "../utils/encryption-key";
import { getOptionalExecutionContext } from "../utils/execution-context";
import { isWithinRateLimit } from "../utils/rate-limit";
import { isMetaCapiBrowserCircuitOpen, openMetaCapiBrowserCircuit } from "../utils/meta-capi-circuit";
import { isTikTokBrowserCircuitOpen, openTikTokBrowserCircuit } from "../utils/tiktok-events-circuit";
import { sendTikTokBrowserEvent, tiktokEventForMetaEvent } from "@scalius/core/integrations/tiktok/browser-relay";
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
      /** TikTok's `_ttp` browser id and landing `ttclid` (the Events API relay only). */
      ttp: z.string().max(128).optional(),
      ttclid: z.string().max(500).optional(),
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
    .optional(),
  /** The buyer refused the sale or sharing of data: Meta Limited Data Use, TikTok limited_data_use. */
  limitedDataUse: z.boolean().optional(),
});

function isTrustedEventSource(eventSourceUrl: string, storefrontUrl?: string): boolean {
  const expectedStorefrontUrl = storefrontUrl?.trim();
  if (!expectedStorefrontUrl) {
    return false;
  }

  try {
    return new URL(eventSourceUrl).origin === new URL(expectedStorefrontUrl).origin;
  } catch {
    return false;
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
  const body = c.req.valid("json");
  const eventId = body.eventId ?? createId();

  if (!isTrustedEventSource(body.eventSourceUrl, c.env.STOREFRONT_URL)) {
    throw new ValidationError("Event source URL is not trusted for this storefront.");
  }

  const db = c.get("db");
  // The same event also goes to the TikTok Events API (its own circuit), with
  // the event id the pixels used. Purchase is the server outboxes' alone.
  const [metaOpen, tiktokOpen] = await Promise.all([
    isMetaCapiBrowserCircuitOpen(db, c.env),
    isTikTokBrowserCircuitOpen(db, c.env),
  ]);
  const relayTikTok = !tiktokOpen && tiktokEventForMetaEvent(body.eventName) !== null;
  if (metaOpen && !relayTikTok) {
    return ok(c, {
      message:
        "Event skipped because Meta CAPI recently failed. Save valid Meta settings to retry sooner.",
      eventId,
    });
  }

  // Browser tracking fires on every page view; the native limiter costs no database work.
  if (!(await isWithinRateLimit(c.env, "RL_STANDARD", "meta-events", getClientIp(c.req.raw)))) {
    throw new RateLimitError("Too many tracking events. Please try again later.");
  }

  const clientIp = getClientIp(c.req.raw);
  const clientIpForMeta =
    clientIp === "unknown" ? c.req.header("x-real-ip") : clientIp;

  const eventTime = Math.floor(Date.now() / 1000);
  const encryptionKey = getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>);
  const clientIpAddress = body.userData.client_ip_address || clientIpForMeta;
  const clientUserAgent = body.userData.client_user_agent || c.req.header("user-agent");

  const metaPromise = metaOpen ? null : sendCapiEvent(db, {
    event_name: body.eventName,
    event_time: eventTime,
    event_source_url: body.eventSourceUrl,
    event_id: eventId,
    action_source: body.actionSource,
    user_data: {
      ...body.userData,
      client_ip_address: clientIpAddress,
      client_user_agent: clientUserAgent,
    },
    custom_data: body.customData,
    // Limited Data Use, geolocated by Meta.
    ...(body.limitedDataUse
      ? { data_processing_options: ["LDU"], data_processing_options_country: 0, data_processing_options_state: 0 }
      : {}),
  }, {
    encryptionKey,
  }).then(async (result) => {
    if (!result.success && result.retryable === false) {
      await openMetaCapiBrowserCircuit(db, c.env, result.error || "non-retryable Meta CAPI failure", body.eventName);
    }
    return result;
  });

  const tiktokPromise = relayTikTok
    ? sendTikTokBrowserEvent(db, {
      eventName: body.eventName,
      eventId,
      eventTime,
      eventSourceUrl: body.eventSourceUrl,
      userData: {
        em: body.userData.em,
        ph: body.userData.ph,
        external_id: body.userData.external_id,
        ttp: typeof body.userData.ttp === "string" ? body.userData.ttp.slice(0, 128) : undefined,
        ttclid: typeof body.userData.ttclid === "string" ? body.userData.ttclid.slice(0, 500) : undefined,
        client_ip_address: clientIpAddress,
        client_user_agent: clientUserAgent,
      },
      customData: body.customData,
      limitedDataUse: body.limitedDataUse === true,
    }, { encryptionKey }).then(async (result) => {
      if (!result.success && result.retryable === false) {
        await openTikTokBrowserCircuit(db, c.env, result.error || "non-retryable TikTok Events API failure");
      }
      return result;
    })
    : null;

  const eventPromise = Promise.all([metaPromise, tiktokPromise]);
  const executionCtx = getOptionalExecutionContext(c);
  if (executionCtx && typeof executionCtx.waitUntil === "function") {
    executionCtx.waitUntil(eventPromise);
  } else {
    await eventPromise;
  }

  return ok(c, {
    message: "Event received and is being processed.",
    eventId: eventId
  });
});

export { app as metaConversionsRoutes };
