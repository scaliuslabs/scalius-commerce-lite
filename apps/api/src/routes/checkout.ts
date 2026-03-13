// src/server/routes/checkout.ts
// Public endpoint for storefront checkout configuration.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getStripeSettings, getSSLCommerzSettings, getPolarSettings } from "@scalius/core/modules/payments/gateway-settings";
import { getDb } from "@scalius/database/client";
import { siteSettings, settings } from "@scalius/database/schema";
import { eq } from "drizzle-orm";
import { cacheMiddleware } from "../middleware/cache";

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
    ttl: 60000,
    keyPrefix: "api:checkout:config:",
    varyByQuery: false,
    methods: ["GET"]
  }),
);

app.openapi(getCheckoutConfigRoute, async (c) => {
  try {
    const db = getDb(c.env);
    const kv: KVNamespace | undefined = (c.env as any).CACHE;

    const [stripeSettings, sslSettings, polarSettings, siteSettingsRow, currencyRows] = await Promise.all([
      getStripeSettings(db, kv).catch(() => null),
      getSSLCommerzSettings(db, kv).catch(() => null),
      getPolarSettings(db, kv).catch(() => null),
      db.select({
        guestCheckoutEnabled: siteSettings.guestCheckoutEnabled,
        authVerificationMethod: siteSettings.authVerificationMethod,
        checkoutMode: siteSettings.checkoutMode,
        partialPaymentEnabled: siteSettings.partialPaymentEnabled,
        partialPaymentAmount: siteSettings.partialPaymentAmount
      }).from(siteSettings).limit(1).then((rows) => rows[0] ?? null).catch(() => null),
      db.select({ key: settings.key, value: settings.value })
        .from(settings)
        .where(eq(settings.category, "currency"))
        .all()
        .catch(() => [] as { key: string; value: string }[]),
    ]);

    const currencyMap = Object.fromEntries(currencyRows.map((r) => [r.key, r.value]));
    const localCurrencyCode = (currencyMap.currency_code ?? "bdt").toLowerCase();

    const gateways: Array<{
      id: string;
      name: string;
      publishableKey?: string;
      currencies: string[];
      sandbox?: boolean;
    }> = [];

    const checkoutMode = siteSettingsRow?.checkoutMode ?? "all";

    if (stripeSettings?.enabled && stripeSettings.publishableKey && checkoutMode !== "guest_cod_only") {
      gateways.push({
        id: "stripe",
        name: "Card Payment",
        publishableKey: stripeSettings.publishableKey,
        currencies: [localCurrencyCode, "usd", "eur", "gbp"]
      });
    }

    if (sslSettings?.enabled && checkoutMode !== "guest_cod_only") {
      gateways.push({
        id: "sslcommerz",
        name: "Online Payment",
        currencies: [localCurrencyCode],
        sandbox: sslSettings.sandbox
      });
    }

    if (polarSettings?.enabled && checkoutMode !== "guest_cod_only") {
      gateways.push({
        id: "polar",
        name: "Polar",
        currencies: [localCurrencyCode, "usd"],
        sandbox: polarSettings.sandbox
      });
    }

    if (checkoutMode !== "gateways_only") {
      gateways.push({
        id: "cod",
        name: "Cash on Delivery",
        currencies: [localCurrencyCode]
      });
    }

    return c.json({
      gateways,
      guestCheckoutEnabled: siteSettingsRow?.guestCheckoutEnabled ?? true,
      authVerificationMethod: siteSettingsRow?.authVerificationMethod ?? "email",
      checkoutMode,
      partialPaymentEnabled: siteSettingsRow?.partialPaymentEnabled ?? false,
      partialPaymentAmount: siteSettingsRow?.partialPaymentAmount ?? 0
    }, 200);
  } catch (error) {
    console.error("Error fetching checkout config:", error);
    return c.json({
      gateways: [{ id: "cod", name: "Cash on Delivery", currencies: ["bdt"] }],
      guestCheckoutEnabled: true,
      authVerificationMethod: "email",
      checkoutMode: "all",
      partialPaymentEnabled: false,
      partialPaymentAmount: 0
    }, 200);
  }
});

export { app as checkoutRoutes };
