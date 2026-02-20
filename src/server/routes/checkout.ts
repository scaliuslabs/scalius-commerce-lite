// src/server/routes/checkout.ts
// Public endpoint for storefront checkout configuration.
//
// GET /checkout/config — returns enabled payment gateways and their public credentials.
// No auth required: publishable keys and enabled flags are public-facing information.

import { Hono } from "hono";
import { getStripeSettings, getSSLCommerzSettings } from "@/lib/payment/gateway-settings";
import { getDb } from "@/db";

const app = new Hono<{ Bindings: Env }>();

/**
 * GET /api/v1/checkout/config
 *
 * Returns enabled payment methods for the storefront checkout UI.
 * Stripe publishable key is safe to expose publicly.
 * SSLCommerz credentials are NOT included (gateway uses redirect flow).
 * COD is always available unless explicitly disabled.
 *
 * Response shape:
 * {
 *   gateways: [
 *     { id: "stripe",     name: "Card Payment",       publishableKey: "pk_...", currencies: ["bdt","usd"] },
 *     { id: "sslcommerz", name: "SSLCommerz",          currencies: ["bdt"] },
 *     { id: "cod",        name: "Cash on Delivery",    currencies: ["bdt"] },
 *   ]
 * }
 */
app.get("/config", async (c) => {
  try {
    const db = getDb(c.env);
    const kv: KVNamespace | undefined = (c.env as any).CACHE;

    // Fetch gateway settings in parallel (DB → KV cached)
    const [stripeSettings, sslSettings] = await Promise.all([
      getStripeSettings(db, kv).catch(() => null),
      getSSLCommerzSettings(db, kv).catch(() => null),
    ]);

    const gateways: Array<{
      id: string;
      name: string;
      publishableKey?: string;
      currencies: string[];
      sandbox?: boolean;
    }> = [];

    if (stripeSettings?.enabled && stripeSettings.publishableKey) {
      gateways.push({
        id: "stripe",
        name: "Card Payment",
        publishableKey: stripeSettings.publishableKey,
        currencies: ["bdt", "usd", "eur", "gbp"],
      });
    }

    if (sslSettings?.enabled) {
      gateways.push({
        id: "sslcommerz",
        name: "Online Payment",
        currencies: ["bdt"],
        sandbox: sslSettings.sandbox,
      });
    }

    // COD is always available as a fallback
    gateways.push({
      id: "cod",
      name: "Cash on Delivery",
      currencies: ["bdt"],
    });

    return c.json({ gateways });
  } catch (error) {
    console.error("Error fetching checkout config:", error);
    // Degrade gracefully — always offer COD as a fallback
    return c.json({
      gateways: [{ id: "cod", name: "Cash on Delivery", currencies: ["bdt"] }],
    });
  }
});

export { app as checkoutRoutes };
