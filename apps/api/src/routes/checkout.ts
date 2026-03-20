// src/server/routes/checkout.ts
// Public endpoint for storefront checkout configuration.

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
// Side-effect import: registers all gateway metadata in the registry
import "@scalius/core/modules/payments/gateway-settings";
import { getCheckoutConfig } from "@scalius/core/modules/settings/checkout-config.service";
import { cacheMiddleware } from "../middleware/cache";

import { ok } from "../utils/api-response";
const app = new OpenAPIHono<{ Bindings: Env }>();

// ─── GET /config ─────────────────────────────────────────────────────────────

const getCheckoutConfigRoute = createRoute({
  method: "get",
  path: "/config",
  tags: ["Checkout"],
  summary: "Get checkout configuration (payment gateways, auth settings)",
  responses: {
    200: { description: "Checkout configuration"  }
  }
});

app.use(
  "/config",
  cacheMiddleware({
    ttl: 60,
    keyPrefix: "api:checkout:config:",
    varyByQuery: false,
    methods: ["GET"]
  }),
);

app.openapi(getCheckoutConfigRoute, async (c) => {
  try {
    const db = c.get("db");
    const kv: KVNamespace | undefined = c.env.CACHE;

    const config = await getCheckoutConfig(db, kv);

    return ok(c, config);
  } catch (error: unknown) {
    console.error("Error fetching checkout config:", error);
    return ok(c, {
      gateways: [{ id: "cod", name: "Cash on Delivery", currencies: ["bdt"] }],
      guestCheckoutEnabled: true,
      authVerificationMethod: "email",
      checkoutMode: "all",
      partialPaymentEnabled: false,
      partialPaymentAmount: 0
    });
  }
});

export { app as checkoutRoutes };
