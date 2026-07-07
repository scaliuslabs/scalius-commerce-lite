// src/server/routes/meta-conversions.ts

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createId } from "@paralleldrive/cuid2";
import {
  sendCapiEvent,
  type SendCapiEventResult,
} from "@scalius/core/integrations/meta/conversions-api";
import { getClientIp, rateLimit } from "@scalius/shared/rate-limit";

import { ok } from "../utils/api-response";
import { errorResponses, successEnvelope } from "../schemas/responses";
import { RateLimitError, ValidationError } from "../utils/api-error";
import { getCredentialEncryptionKey } from "../utils/encryption-key";
import { getOptionalExecutionContext } from "../utils/cache-invalidation";
const app = new OpenAPIHono<{ Bindings: Env }>();
export const META_CAPI_BROWSER_CIRCUIT_KEY =
  "meta-capi:browser-events:circuit";
const META_CAPI_BROWSER_CIRCUIT_TTL_SECONDS = 15 * 60;

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

async function readMetaCapiBrowserCircuit(kv: KVNamespace | undefined) {
  if (!kv) return null;
  try {
    const raw = await kv.get(META_CAPI_BROWSER_CIRCUIT_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as {
      reason?: string;
      eventName?: string;
      openedAt?: number;
    };
  } catch (error) {
    console.warn("[Meta CAPI] Failed to read browser event circuit", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function openMetaCapiBrowserCircuit(
  kv: KVNamespace | undefined,
  result: SendCapiEventResult,
  eventName: string,
) {
  if (!kv || result.success || result.retryable !== false) return;

  try {
    await kv.put(
      META_CAPI_BROWSER_CIRCUIT_KEY,
      JSON.stringify({
        reason: result.error || "non-retryable Meta CAPI failure",
        eventName,
        openedAt: Date.now(),
      }),
      { expirationTtl: META_CAPI_BROWSER_CIRCUIT_TTL_SECONDS },
    );
  } catch (error) {
    console.warn("[Meta CAPI] Failed to open browser event circuit", {
      error: error instanceof Error ? error.message : String(error),
    });
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

  const kv = c.env.CACHE as KVNamespace | undefined;
  if (kv) {
    const circuit = await readMetaCapiBrowserCircuit(kv);
    if (circuit) {
      return ok(c, {
        message:
          "Event skipped because Meta CAPI recently failed. Save valid Meta settings to retry sooner.",
        eventId,
      });
    }

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
    encryptionKey: getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>),
  }).then(async (result) => {
    await openMetaCapiBrowserCircuit(kv, result, body.eventName);
    return result;
  });

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
