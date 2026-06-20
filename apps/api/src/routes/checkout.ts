// src/server/routes/checkout.ts
// Public endpoint for storefront checkout configuration.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
// Side-effect import: registers all gateway metadata in the registry
import "@scalius/core/modules/payments/gateway-settings";
import { getCheckoutConfig } from "@scalius/core/modules/settings/checkout-config.service";
import { cacheMiddleware } from "../middleware/cache";
import { successEnvelope, errorResponses, errorResponseSchema } from "../schemas/responses";

import { ok } from "../utils/api-response";
import { getCredentialEncryptionKey } from "../utils/encryption-key";
import { CACHE_TTLS } from "../utils/cache-ttls";
const app = new OpenAPIHono<{ Bindings: Env }>();
const CHECKOUT_CONFIG_CACHE_PREFIX = "api:checkout:config:v2:";

// ─── GET /config ─────────────────────────────────────────────────────────────

const getCheckoutConfigRoute = createRoute({
  method: "get",
  path: "/config",
  tags: ["Checkout"],
  summary: "Get checkout configuration (payment gateways, auth settings)",
  responses: {
    200: {
      description: "Checkout configuration",
      content: { "application/json": { schema: successEnvelope(z.record(z.string(), z.unknown())) } },
    },
    503: {
      description: "Checkout configuration temporarily unavailable",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    500: errorResponses[500],
  }
});

app.use(
  "/config",
  cacheMiddleware({
    ttl: CACHE_TTLS.CHECKOUT_CONFIG,
    keyPrefix: CHECKOUT_CONFIG_CACHE_PREFIX,
    varyByQuery: false,
    methods: ["GET"]
  }),
);

app.openapi(getCheckoutConfigRoute, async (c) => {
  try {
    const db = c.get("db");
    const kv: KVNamespace | undefined = c.env.CACHE;

    const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
    const config = await getCheckoutConfig(db, kv, encryptionKey);

    return ok(c, config);
  } catch (error: unknown) {
    console.error("[checkout] Error fetching checkout config:", error instanceof Error ? error.message : error);
    c.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
    c.header("Pragma", "no-cache");
    c.header("Expires", "0");
    return c.json({
      success: false as const,
      error: {
        code: "CHECKOUT_CONFIG_UNAVAILABLE",
        message: "Checkout configuration is temporarily unavailable. Please try again shortly.",
      },
    }, 503);
  }
});

export { app as checkoutRoutes };
