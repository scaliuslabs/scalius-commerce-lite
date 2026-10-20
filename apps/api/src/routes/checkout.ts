// src/server/routes/checkout.ts
// Public endpoint for storefront checkout configuration.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getCheckoutConfig } from "@scalius/core/modules/checkout";
import { requestPaymentProviders } from "../plugins/providers/payment";
import { requestAppProviders } from "../plugins/providers/app-providers";
import { successEnvelope, errorResponses, errorResponseSchema } from "../schemas/responses";
import { readinessSchema } from "../schemas/readiness";

import { ok } from "../utils/api-response";
import { getCredentialEncryptionKey } from "../utils/encryption-key";
import { publicMarketPresence } from "../utils/public-market";
import { NotFoundError } from "../utils/api-error";
const app = new OpenAPIHono<{ Bindings: Env }>();

/** One buyer-selectable payment method: a registered gateway or cash on delivery. */
const checkoutGatewaySchema = z.object({
  id: z.string(),
  name: z.string(),
  /**
   * card: confirm in the browser; hosted: redirect to the provider; cod: no
   * online payment; deferred: pay later by its due date (an invoice). A
   * deferred method reaches only signed-in buyers it names: the buyer's tax
   * quote (`allowedPaymentMethods`) says whether it does.
   */
  flow: z.enum(["card", "hosted", "cod", "deferred"]),
  /** A deferred method's terms: the order is due this many days after it is placed. */
  dueInDays: z.number().int().min(1).max(365).optional(),
  currencies: z.array(z.string()).max(4),
  /**
   * The delivery countries it serves, when not every country (cash on
   * delivery: ["BD"]). Checkout hides it for a delivery elsewhere; pickup
   * and orders that ship nothing have no delivery country.
   */
  countries: z.array(z.string().length(2)).max(250).optional(),
  testMode: z.boolean().optional(),
  publishableKey: z.string().optional(),
  amountLimits: z.object({
    currency: z.string(),
    min: z.number().positive(),
    max: z.number().positive(),
  }).optional(),
});

const checkoutConfigSchema = z.object({
  gateways: z.array(checkoutGatewaySchema).max(32),
  activeDefaultMethod: z.string().optional(),
  guestCheckoutEnabled: z.boolean(),
  /** Settings → Customer accounts. `channels` lists only chosen code channels that can send now. */
  customerIdentity: z.object({
    email: z.enum(["required", "optional", "hidden"]),
    whatsapp: z.enum(["off", "same_as_phone", "separate"]),
    channels: z.array(z.enum(["email", "sms", "whatsapp"])).max(3),
    /** The merchant's opt-in: phone may be optional for digital/service-only orders (`orderContactNeeds`). */
    phoneOptionalForDigital: z.boolean(),
  }),
  checkoutMode: z.enum(["guest_cod_only", "gateways_only", "all"]),
  partialPaymentEnabled: z.boolean(),
  partialPaymentAmount: z.number().min(0),
  /**
   * Settings → Checkout: every order asks for a full billing address. Off: an
   * order that ships is billed at its shipping address, and one that ships
   * nothing asks only its country plus the region and postal code its rules
   * require.
   */
  requireFullBillingAddress: z.boolean(),
  allowedCountries: z.array(z.string()).max(250),
  allowedCountriesMode: z.enum(["include", "exclude"]),
  currency: z.object({
    code: z.string(),
    symbol: z.string(),
    decimalPlaces: z.number().int().min(0).max(3),
  }),
  checkoutReadiness: readinessSchema.extend({
    hasActiveShippingMethod: z.boolean(),
    hasActiveDeliveryHierarchy: z.boolean(),
    customerSignInRequired: z.boolean(),
    hasUsableCustomerSignIn: z.boolean(),
  }),
  unavailable: z.boolean(),
  unavailableMessage: z.string().optional(),
  /**
   * The market of the page's presence (`?presence=en-in`; none: the root,
   * the backup market). Payment and delivery methods are store-wide until
   * markets link them; the order's market is its shipping country's.
   */
  market: z.object({
    id: z.string(),
    handle: z.string(),
    name: z.string(),
    locale: z.string(),
  }),
  /** The marketing consent checkbox: unchecked by default, never required. */
  marketingConsent: z.object({
    enabled: z.boolean(),
    channels: z.array(z.enum(["email", "sms", "whatsapp"])).max(3),
    label: z.object({ en: z.string().max(200), bn: z.string().max(200) }),
  }),
});

// ─── GET /config ─────────────────────────────────────────────────────────────

const getCheckoutConfigRoute = createRoute({
  method: "get",
  path: "/config",
  operationId: "storefront.checkout.get_config",
  tags: ["Checkout"],
  summary: "Get checkout configuration (payment gateways, auth settings)",
  description: "The checkout settings of the page's market: `presence` names a subfolder presence (`en-in`); without it the root presence, the backup market. An inactive or unknown presence answers 404.",
  request: {
    query: z.object({
      presence: z.string().max(5).optional().openapi({ description: "A subfolder presence such as `en-in`; omit for the root." }),
    }),
  },
  responses: {
    200: {
      description: "Checkout configuration",
      content: { "application/json": { schema: successEnvelope(checkoutConfigSchema) } },
    },
    404: errorResponses[404],
    503: {
      description: "Checkout configuration temporarily unavailable",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    500: errorResponses[500],
  }
});

app.openapi(getCheckoutConfigRoute, async (c) => {
  const db = c.get("db");
  const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
  // The page's presence decides the market; it is read in the settings' D1 call.
  const presence = publicMarketPresence(c);
  try {
    const config = await getCheckoutConfig(
      db,
      encryptionKey,
      c.env as unknown as Record<string, unknown>,
      // The store's gateways now: built in plus the active app providers
      // (read only when the merchant enabled an app's method).
      () => requestPaymentProviders(c),
      // Customer sign-in channels may send through an app the merchant chose.
      requestAppProviders(c),
      presence,
    );
    // A presence no active market holds is a 404 (core's NotFoundError, rethrown below).
    const { id, handle, name, presence: { locale } } = config.market!;
    return ok(c, checkoutConfigSchema.parse({ ...config, market: { id, handle, name, locale } }));
  } catch (error: unknown) {
    // An unknown presence is a 404, never the unavailable-config answer below.
    if (error instanceof NotFoundError) throw error;
    console.error("[checkout] Error fetching checkout config:", error instanceof Error ? error.message : error);
    c.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
    c.header("Pragma", "no-cache");
    c.header("Expires", "0");
    return c.json({
      success: false as const,
      error: {
        code: "checkout_config_unavailable",
        message: "Checkout configuration is temporarily unavailable. Please try again shortly.",
      },
    }, 503);
  }
});

export { app as checkoutRoutes };
