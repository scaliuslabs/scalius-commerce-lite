// src/server/routes/checkout.ts
// Public endpoint for storefront checkout configuration.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getRegisteredGateways } from "@scalius/core/modules/payments/gateway-registry";
// Side-effect import: registers all gateway metadata in the registry
import "@scalius/core/modules/payments/gateway-settings";
import { getDb } from "@scalius/database/client";
import { siteSettings, settings } from "@scalius/database/schema";
import { eq, and } from "drizzle-orm";
import { getDecimalPlaces } from "@scalius/shared/currency";
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
    const db = getDb(c.env);
    const kv: KVNamespace | undefined = c.env.CACHE;

    const [siteSettingsRow, currencyRows, allowedCountriesRow] = await Promise.all([
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
      db.select({ value: settings.value })
        .from(settings)
        .where(and(eq(settings.category, "phone"), eq(settings.key, "allowed_countries")))
        .get()
        .catch(() => null),
    ]);

    let allowedCountries: string[] = [];
    let allowedCountriesMode: "include" | "exclude" = "include";
    try {
      if (allowedCountriesRow?.value) {
        const parsed = JSON.parse(allowedCountriesRow.value);
        if (Array.isArray(parsed)) {
          // Backward compat: old format was just an array
          allowedCountries = parsed;
        } else if (parsed && typeof parsed === "object") {
          allowedCountries = Array.isArray(parsed.countries) ? parsed.countries : [];
          allowedCountriesMode = parsed.mode === "exclude" ? "exclude" : "include";
        }
      }
    } catch {
      // Invalid JSON — default to empty array
    }

    const currencyMap = Object.fromEntries(currencyRows.map((r) => [r.key, r.value]));
    const localCurrencyCode = (currencyMap.currency_code ?? "bdt").toLowerCase();
    const currencyDecimalPlaces = getDecimalPlaces(localCurrencyCode);

    const checkoutMode = siteSettingsRow?.checkoutMode ?? "all";

    // Dynamically resolve enabled gateways from the registry
    const registeredGateways = getRegisteredGateways();
    const gatewaySettingsPromises = registeredGateways.map((gw) =>
      gw.getSettings(db, kv).catch(() => null)
    );
    const settingsResults = await Promise.all(gatewaySettingsPromises);

    const gateways: Array<Record<string, unknown>> = [];

    for (let i = 0; i < registeredGateways.length; i++) {
      const gw = registeredGateways[i];
      if (!gw) continue;
      const gwSettings = settingsResults[i];
      if (!gwSettings?.enabled) continue;
      if (gw.id === "cod" && checkoutMode === "gateways_only") continue;
      if (gw.id !== "cod" && checkoutMode === "guest_cod_only") continue;

      gateways.push({
        id: gw.id,
        name: gw.name,
        currencies: gw.getCurrencies?.(localCurrencyCode) || [localCurrencyCode],
        ...(gw.getPublicConfig?.(gwSettings as Record<string, unknown>) || {}),
      });
    }

    return ok(c, {
      gateways,
      guestCheckoutEnabled: siteSettingsRow?.guestCheckoutEnabled ?? true,
      authVerificationMethod: siteSettingsRow?.authVerificationMethod ?? "email",
      checkoutMode,
      partialPaymentEnabled: siteSettingsRow?.partialPaymentEnabled ?? false,
      partialPaymentAmount: siteSettingsRow?.partialPaymentAmount ?? 0,
      allowedCountries,
      allowedCountriesMode,
      currency: {
        code: localCurrencyCode,
        symbol: currencyMap.currency_symbol ?? "\u09F3",
        decimalPlaces: currencyDecimalPlaces,
      },
    });
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
