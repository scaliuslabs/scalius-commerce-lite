// src/server/routes/checkout.ts
// Public endpoint for storefront checkout configuration.
//
// GET /checkout/config — returns enabled payment gateways and their public credentials.
// No auth required: publishable keys and enabled flags are public-facing information.

import { Hono } from "hono";
import { getStripeSettings, getSSLCommerzSettings } from "@/lib/payment/gateway-settings";
import { getDb } from "@/db";
import { siteSettings, settings } from "@/db/schema";
import { eq } from "drizzle-orm";

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

    // Fetch gateway settings + site settings + currency settings in parallel (DB → KV cached)
    const [stripeSettings, sslSettings, siteSettingsRow, currencyRows] = await Promise.all([
      getStripeSettings(db, kv).catch(() => null),
      getSSLCommerzSettings(db, kv).catch(() => null),
      db.select({
        guestCheckoutEnabled: siteSettings.guestCheckoutEnabled,
        authVerificationMethod: siteSettings.authVerificationMethod,
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

    if (stripeSettings?.enabled && stripeSettings.publishableKey) {
      gateways.push({
        id: "stripe",
        name: "Card Payment",
        publishableKey: stripeSettings.publishableKey,
        currencies: [localCurrencyCode, "usd", "eur", "gbp"],
      });
    }

    if (sslSettings?.enabled) {
      gateways.push({
        id: "sslcommerz",
        name: "Online Payment",
        currencies: [localCurrencyCode],
        sandbox: sslSettings.sandbox,
      });
    }

    // COD is always available as a fallback
    gateways.push({
      id: "cod",
      name: "Cash on Delivery",
      currencies: [localCurrencyCode],
    });

    return c.json({
      gateways,
      guestCheckoutEnabled: siteSettingsRow?.guestCheckoutEnabled ?? true,
      authVerificationMethod: siteSettingsRow?.authVerificationMethod ?? "email",
    });
  } catch (error) {
    console.error("Error fetching checkout config:", error);
    // Degrade gracefully — always offer COD as a fallback
    return c.json({
      gateways: [{ id: "cod", name: "Cash on Delivery", currencies: ["bdt"] }],
      guestCheckoutEnabled: true,
      authVerificationMethod: "email",
    });
  }
});

export { app as checkoutRoutes };
