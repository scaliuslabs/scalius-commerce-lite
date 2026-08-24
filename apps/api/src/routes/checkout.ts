// src/server/routes/checkout.ts
// Public endpoint for storefront checkout configuration.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
// Side-effect import: registers all gateway metadata in the registry
import "@scalius/core/modules/payments/gateway-settings";
import { getCheckoutConfig } from "@scalius/core/modules/settings/checkout-config.service";
import { successEnvelope, errorResponses, errorResponseSchema } from "../schemas/responses";

import { ok } from "../utils/api-response";
import { getCredentialEncryptionKey } from "../utils/encryption-key";
const app = new OpenAPIHono<{ Bindings: Env }>();

const checkoutGatewayBaseSchema = {
  name: z.string(),
  currencies: z.array(z.string()).max(4),
} as const;
const checkoutGatewaySchema = z.discriminatedUnion("id", [
  z.object({
    id: z.literal("stripe"),
    ...checkoutGatewayBaseSchema,
    publishableKey: z.string(),
    testMode: z.boolean(),
  }),
  z.object({
    id: z.literal("sslcommerz"),
    ...checkoutGatewayBaseSchema,
    sandbox: z.boolean(),
    testMode: z.boolean(),
    amountLimits: z.object({
      currency: z.literal("BDT"),
      min: z.number().positive(),
      max: z.number().positive(),
    }),
  }),
  z.object({
    id: z.literal("polar"),
    ...checkoutGatewayBaseSchema,
    sandbox: z.boolean(),
    testMode: z.boolean(),
  }),
  z.object({
    id: z.literal("cod"),
    ...checkoutGatewayBaseSchema,
  }),
]);

const checkoutConfigSchema = z.object({
  gateways: z.array(checkoutGatewaySchema).max(4),
  activeDefaultMethod: z.enum(["stripe", "sslcommerz", "polar", "cod"]).optional(),
  guestCheckoutEnabled: z.boolean(),
  authVerificationMethod: z.enum(["email", "sms_otp", "whatsapp_otp", "both"]),
  customerAuthPolicy: z.object({
    otpChannels: z.array(z.enum(["email", "sms", "whatsapp"])).max(3),
    requiredContactFields: z.array(z.enum(["email", "phone"])).max(2),
    optionalContactFields: z.array(z.enum(["email", "phone"])).max(2),
    defaultOtpChannel: z.enum(["email", "sms", "whatsapp"]),
  }),
  checkoutMode: z.enum(["guest_cod_only", "gateways_only", "all"]),
  partialPaymentEnabled: z.boolean(),
  partialPaymentAmount: z.number().min(0),
  allowedCountries: z.array(z.string()).max(250),
  allowedCountriesMode: z.enum(["include", "exclude"]),
  currency: z.object({
    code: z.string(),
    symbol: z.string(),
    decimalPlaces: z.number().int().min(0).max(3),
  }),
  checkoutReadiness: z.object({
    ready: z.boolean(),
    hasActiveShippingMethod: z.boolean(),
    hasActiveDeliveryHierarchy: z.boolean(),
    customerSignInRequired: z.boolean(),
    hasUsableCustomerSignIn: z.boolean(),
    issues: z.array(z.string()).max(3),
  }),
  unavailable: z.boolean(),
  unavailableMessage: z.string().optional(),
});

// ─── GET /config ─────────────────────────────────────────────────────────────

const getCheckoutConfigRoute = createRoute({
  method: "get",
  path: "/config",
  operationId: "storefront.checkout.get_config",
  tags: ["Checkout"],
  summary: "Get checkout configuration (payment gateways, auth settings)",
  responses: {
    200: {
      description: "Checkout configuration",
      content: { "application/json": { schema: successEnvelope(checkoutConfigSchema) } },
    },
    503: {
      description: "Checkout configuration temporarily unavailable",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    500: errorResponses[500],
  }
});

app.openapi(getCheckoutConfigRoute, async (c) => {
  try {
    const db = c.get("db");

    const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
    const config = await getCheckoutConfig(
      db,
      encryptionKey,
      c.env as unknown as Record<string, unknown>,
    );

    return ok(c, checkoutConfigSchema.parse(config));
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
