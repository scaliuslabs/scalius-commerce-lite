// Checkout: the idempotent storefront order commit.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Database } from "@scalius/database/client";
import { PaymentMethod, PaymentStatus, InventoryPool } from "@scalius/database/schema";
import { discountCodesSchema } from "../../schemas/storefront-discounts";
import {
    getCheckoutGatewayPrecommitIssue,
    getPaymentMethodCurrencyIssue,
    isOnlinePaymentMethod,
    listPaymentMethodIds,
} from "@scalius/core/modules/payments";
import { phoneNumberSchema } from "@scalius/shared/customer-utils";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { getCustomerBySession } from "@scalius/core/modules/customers";
import { fromMinor } from "@scalius/shared/money";
import type { CheckoutPaymentMethodId } from "@scalius/core/modules/settings";
import {
    assertStorefrontCheckoutQuoteFingerprint,
    buildStorefrontCheckoutQuoteFingerprint,
} from "@scalius/core/modules/checkout/browser";
import {
    buildCheckoutAttemptIdentity,
    commitStorefrontOrderPayload,
    createAtomicCheckoutAttempt,
    createStorefrontOrder,
    createTrustedStorefrontCheckoutPolicySnapshot,
    resolveExistingCheckoutAttempt,
    runStorefrontOrderPostCommitSideEffects,
    assertStorefrontCheckoutPolicy,
    loadStorefrontCheckoutReads,
    type StorefrontCheckoutAuthoritySnapshot,
    type StorefrontCheckoutSettingsSnapshot,
} from "@scalius/core/modules/checkout";
import { bumpCacheGeneration, getOptionalExecutionContext } from "../../utils/cache-generation";
import { enqueueOrderAutoFulfil } from "../../utils/auto-fulfil-queue";
import { AppError, ValidationError, RateLimitError, UnauthorizedError } from "../../utils/api-error";
import { getCredentialEncryptionKey, getCustomerSessionHashKey } from "../../utils/encryption-key";
import { getClientIp } from "@scalius/shared/rate-limit";
import { isWithinRateLimit } from "../../utils/rate-limit";
import { created } from "../../utils/api-response";
import { errorResponses, serviceUnavailableResponse, conflictResponse } from "../../schemas/responses";
import { linePropertiesInputSchema } from "../../schemas/order-lines";
import {
    getCustomerSessionTokenFromRequest,
    persistedStorefrontVariantIdSchema,
    scheduleCheckoutSuccessRecoveryHints,
    scheduleCheckoutFailureStatusHint,
} from "./shared";

const app = new OpenAPIHono<{ Bindings: Env }>();

type CheckoutCustomerIdentity = {
  customerId: string;
  source: "authenticated";
} | null;
type CheckoutSettingsSnapshot = StorefrontCheckoutSettingsSnapshot;
type CheckoutOrderPolicyResult = {
  customerIdentity: CheckoutCustomerIdentity;
  checkoutSettings: CheckoutSettingsSnapshot;
};

type CheckoutDiagnosticPhase =
  | "attempt"
  | "authority"
  | "policy"
  | "prepare"
  | "rate_limit"
  | "commit"
  | "post_commit";

function createCheckoutDiagnostics(env: Env): {
  mark: (phase: CheckoutDiagnosticPhase) => void;
  apply: (context: { header: (name: string, value: string) => void }) => void;
} | null {
  if (
    (env as unknown as Record<string, unknown>).CHECKOUT_LOADTEST_DIAGNOSTICS
      !== "1"
  ) {
    return null;
  }
  let last = performance.now();
  const durations: Array<{ phase: CheckoutDiagnosticPhase; durationMs: number }> = [];
  return {
    mark(phase) {
      const now = performance.now();
      durations.push({ phase, durationMs: Math.max(0, now - last) });
      last = now;
    },
    apply(context) {
      context.header(
        "Server-Timing",
        durations.map(({ phase, durationMs }) =>
          `${phase};dur=${durationMs.toFixed(1)}`
        ).join(", "),
      );
    },
  };
}

async function enforceCheckoutRateLimits(
  env: Env,
  request: Request,
  customerPhone: string,
): Promise<void> {
  const [ipAllowed, phoneAllowed] = await Promise.all([
    isWithinRateLimit(env, "RL_STANDARD", "checkout-ip", getClientIp(request)),
    isWithinRateLimit(env, "RL_STRICT", "checkout-phone", customerPhone),
  ]);
  if (!ipAllowed || !phoneAllowed) {
    throw new RateLimitError("Too many order requests. Please try again later.");
  }
}

async function assertCheckoutOrderPolicy(
  c: {
    env: Env;
    get: (key: "db") => Database;
    req: { header: (name: string) => string | undefined };
  },
  customerPhone: string,
  paymentMethod: CheckoutPaymentMethodId,
  authority: Pick<
    StorefrontCheckoutAuthoritySnapshot,
    "checkoutSettings" | "allowedCountries" | "activePaymentMethods"
  >,
): Promise<CheckoutOrderPolicyResult> {
  const db = c.get("db");
  const checkoutSettings = authority.checkoutSettings;
  const checkoutSettingsSnapshot = assertStorefrontCheckoutPolicy(
    customerPhone,
    paymentMethod,
    authority,
  );

  const sessionToken = getCustomerSessionTokenFromRequest(c);
  if (!sessionToken) {
    if (checkoutSettings?.guestCheckoutEnabled ?? true) {
      return { customerIdentity: null, checkoutSettings: checkoutSettingsSnapshot };
    }

    throw new UnauthorizedError("Please sign in before checkout.");
  }

  const session = await getCustomerBySession(
    db,
    sessionToken,
    getCustomerSessionHashKey(c.env as unknown as Record<string, unknown>),
  );
  if (!session?.customerId) {
    if (checkoutSettings?.guestCheckoutEnabled ?? true) {
      throw new AppError(401, "CUSTOMER_SESSION_STALE", "Your session expired. Please sign in again or continue as a guest.");
    }

    throw new UnauthorizedError("Please sign in before checkout.");
  }

  if (!session.phone) {
    throw new ValidationError(
      "Your signed-in account is missing its required phone number. Update your profile and try again.",
    );
  }

  return {
    customerIdentity: {
      customerId: session.customerId,
      source: "authenticated",
    },
    checkoutSettings: checkoutSettingsSnapshot,
  };
}

const createOrderSchema = z.object({
  checkoutRequestId: z
    .string()
    .trim()
    .min(16, "Checkout request id is required")
    .max(128, "Checkout request id is too long")
    .regex(/^[A-Za-z0-9:_-]+$/, "Checkout request id contains unsupported characters"),
  expectedQuoteFingerprint: z
    .string()
    .regex(/^taxq_[A-Za-z0-9_-]{22}$/, "A current reviewed checkout quote is required")
    .openapi({
      description: "Exact authoritative quote fingerprint reviewed by the buyer before submitting the order.",
    }),
  customerName: z
    .string()
    .min(3, "Customer name must be at least 3 characters")
    .max(100, "Customer name must be less than 100 characters"),
  customerPhone: phoneNumberSchema,
  customerEmail: z.email().nullable(),
  /**
   * Required only when something ships: a physical line with a delivery
   * rate. Pickup, service-only and digital orders omit it (and it is ignored
   * if sent).
   */
  shippingAddress: z
    .string()
    .min(10, "Address must be at least 10 characters")
    .max(500, "Address must be less than 500 characters")
    .nullable()
    .optional(),
  city: z.string().min(1, "City is required").nullable().optional(),
  zone: z.string().min(1, "Zone is required").nullable().optional(),
  area: z.string().nullable().optional(),
  cityName: z.string().nullable().optional(),
  zoneName: z.string().nullable().optional(),
  areaName: z.string().nullable().optional(),
  notes: z
    .string()
    .max(500, "Notes must be less than 500 characters")
    .nullable(),
  items: z.array(
    z.object({
      cartKey: z.string().min(1).max(256).optional().nullable(),
      productId: z.string().min(1, "Product is required"),
      variantId: persistedStorefrontVariantIdSchema,
      quantity: z.number().int("Quantity must be a whole number").min(1, "Quantity must be at least 1").max(99, "Quantity must be at most 99"),
      /** The unit price the buyer saw: base plus the surcharges of its buyer inputs. */
      price: z.number().min(0, "Price must be greater than or equal to 0"),
      productName: z.string().optional().nullable(),
      variantLabel: z.string().optional().nullable(),
      properties: linePropertiesInputSchema,
    }),
  ).min(1, "At least one item is required"),
  discountCodes: discountCodesSchema,
  shippingCharge: z
    .number()
    .min(0, "Shipping charge must be greater than or equal to 0"),
  /** A delivery or pickup rate; required when a line is physical. */
  shippingMethodId: z.string().optional().nullable(),
  paymentMethod: z
    .enum(listPaymentMethodIds() as [string, ...string[]])
    .default(PaymentMethod.COD),
  inventoryPool: z
    .enum([InventoryPool.REGULAR, InventoryPool.PREORDER, InventoryPool.BACKORDER])
    .default(InventoryPool.REGULAR)
});

type CreateOrderInput = z.infer<typeof createOrderSchema>;

function assertGatewayCurrencyReadiness(data: CreateOrderInput, currencyCode: string): void {
  if (!isOnlinePaymentMethod(data.paymentMethod)) return;
  const issue = getPaymentMethodCurrencyIssue(data.paymentMethod, currencyCode);
  if (issue) throw new ValidationError(issue);
}

function assertGatewayPrecommitReadiness(
  data: CreateOrderInput,
  checkoutSettings: CheckoutSettingsSnapshot,
  totalAmountMinor: number,
  currencyCode: string,
): void {
  const issue = getCheckoutGatewayPrecommitIssue({
    paymentMethod: data.paymentMethod,
    currencyCode,
    totalAmountMinor,
    partialPaymentEnabled: checkoutSettings.partialPaymentEnabled,
    partialPaymentAmount: checkoutSettings.partialPaymentAmount,
  });
  if (issue) throw new ValidationError(issue);
}

const checkoutCreatedPayloadSchema = z.object({
  checkoutToken: z.string(),
  receiptToken: z.string(),
  statusToken: z.string(),
  orderId: z.string(),
  paymentMethod: z.string(),
  totalAmount: z.number(),
  totalAmountMinor: z.number().int(),
  taxAmount: z.number(),
  taxAmountMinor: z.number().int(),
  taxLabel: z.string(),
  pricesIncludeTax: z.boolean(),
  currencyCode: z.string(),
  decimalPlaces: z.number().int(),
  /** Some line ships to the buyer's address (false for pickup, service-only and digital orders). */
  requiresShipping: z.boolean().optional(),
  message: z.string(),
});

type CheckoutCreatedPayload = z.infer<typeof checkoutCreatedPayloadSchema>;

const createOrderRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Orders"],
  summary: "Create a new storefront order",
  request: {
    body: {
      content: {
        "application/json": {
          schema: createOrderSchema
        }
      }
    }
  },
  responses: {
    201: {
      description: "Order created",
      content: { "application/json": { schema: z.object({
        success: z.literal(true),
        data: checkoutCreatedPayloadSchema,
      }) } },
    },
    202: {
      description: "Order submit is already processing",
      content: { "application/json": { schema: z.object({
        success: z.literal(true),
        data: z.object({
          statusToken: z.string(),
          orderId: z.string(),
          status: z.literal("processing"),
          message: z.string(),
        }),
      }) } },
    },
    400: errorResponses[400],
    401: errorResponses[401],
    409: conflictResponse,
    429: errorResponses[429],
    500: errorResponses[500],
    503: serviceUnavailableResponse,
  }
});

app.openapi(createOrderRoute, async (c) => {
  const db = c.get("db");
  const data = c.req.valid("json");
  const requestUrl = c.req.url;
  const diagnostics = createCheckoutDiagnostics(c.env);

  try {
    const attemptIdentity = await buildCheckoutAttemptIdentity(data);
    // One read round trip: idempotency row, checkout authority, and the rows
    // the commit needs. A committed request replays before any policy check.
    const checkoutReads = await loadStorefrontCheckoutReads<CheckoutCreatedPayload>(
      db,
      attemptIdentity,
      {
        items: data.items.map((item) => ({
          cartKey: item.cartKey,
          productId: item.productId,
          variantId: item.variantId,
          quantity: item.quantity,
          price: item.price,
          productName: item.productName,
          variantLabel: item.variantLabel,
          properties: item.properties,
        })),
        inventoryPool: data.inventoryPool,
        city: data.city,
        zone: data.zone,
        area: data.area,
        shippingMethodId: data.shippingMethodId,
        customerEmail: data.customerEmail,
        customerPhone: data.customerPhone,
      },
      getCredentialEncryptionKey(c.env as Record<string, unknown>),
    );
    const existingAttempt = checkoutReads.existingAttempt;
    diagnostics?.mark("attempt");

    if (existingAttempt?.status === "replay") {
      return created(c, existingAttempt.response);
    }

    if (existingAttempt?.status === "processing") {
      return c.json({
        success: true,
        data: {
          statusToken: existingAttempt.statusToken,
          orderId: existingAttempt.orderId,
          status: "processing" as const,
          message: "Order creation is already processing.",
        },
      }, 202);
    }
    const retryAttempt = existingAttempt?.status === "retry"
      ? existingAttempt.attempt
      : null;

    const checkoutAuthority = checkoutReads.authority();
    const { currency, cartValidation, deliveryPreflight } = checkoutAuthority;
    diagnostics?.mark("authority");

    const {
      customerIdentity: checkoutCustomerIdentity,
      checkoutSettings,
    } = await assertCheckoutOrderPolicy(
      c,
      data.customerPhone,
      data.paymentMethod as CheckoutPaymentMethodId,
      checkoutAuthority,
    );
    assertGatewayCurrencyReadiness(data, currency.currencyCode);
    diagnostics?.mark("policy");

    // This remains memory-only until the authoritative order batch. The
    // idempotency row, order, inventory mutation, and receipt either all commit
    // or all roll back together.
    const checkoutAttempt = retryAttempt ?? createAtomicCheckoutAttempt(attemptIdentity);

    const result = await createStorefrontOrder(
      db,
      data,
      requestUrl,
      {
        orderId: checkoutAttempt.orderId,
        checkoutToken: checkoutAttempt.checkoutToken,
      },
      cartValidation,
      deliveryPreflight,
      checkoutCustomerIdentity ?? undefined,
      {
        code: currency.currencyCode,
        decimalPlaces: getDecimalPlaces(currency.currencyCode),
      },
      createTrustedStorefrontCheckoutPolicySnapshot({
        partialPaymentEnabled: checkoutSettings.partialPaymentEnabled,
        authorityRevision: checkoutAuthority.authorityRevision,
        orderCreatedNotificationEnabled:
          checkoutAuthority.sideEffects.orderCreatedNotification,
        metaPurchaseEnabled: checkoutAuthority.sideEffects.metaPurchase,
      }),
      checkoutAuthority.taxAuthority,
    );

    assertStorefrontCheckoutQuoteFingerprint(
      data.expectedQuoteFingerprint,
      await buildStorefrontCheckoutQuoteFingerprint(
        result.taxQuote,
        deliveryPreflight.shippingMethod,
        result.linePropertiesHashes,
      ),
    );

    assertGatewayPrecommitReadiness(
      data,
      checkoutSettings,
      result.taxQuote.totalMinor,
      currency.currencyCode,
    );
    diagnostics?.mark("prepare");

    // Only authoritative, policy-valid checkouts consume buyer rate-limit
    // budget. All database writes still remain in the single commit below.
    await enforceCheckoutRateLimits(c.env, c.req.raw, data.customerPhone);
    diagnostics?.mark("rate_limit");

    const executionCtx = getOptionalExecutionContext(c);

    const responsePayload: CheckoutCreatedPayload = {
      checkoutToken: result.checkoutToken,
      receiptToken: result.checkoutToken,
      statusToken: checkoutAttempt.statusToken,
      orderId: result.orderId,
      paymentMethod: result.paymentMethod,
      totalAmount: fromMinor(result.taxQuote.totalMinor, result.taxQuote.decimalPlaces),
      totalAmountMinor: result.taxQuote.totalMinor,
      taxAmount: fromMinor(result.taxQuote.taxMinor, result.taxQuote.decimalPlaces),
      taxAmountMinor: result.taxQuote.taxMinor,
      taxLabel: result.taxQuote.displayLabel,
      pricesIncludeTax: result.taxQuote.pricesIncludeTax,
      currencyCode: result.taxQuote.currencyCode,
      decimalPlaces: result.taxQuote.decimalPlaces,
      requiresShipping: result.requiresShipping,
      message: "Order created",
    };

    let availabilityTransitionVariantIds: string[];
    try {
      ({ availabilityTransitionVariantIds } = await commitStorefrontOrderPayload(
        db,
        result.commitPayload,
        { attempt: checkoutAttempt, response: responsePayload },
        checkoutReads.commitReads,
      ));
    } catch (commitError) {
      const recoveredAttempt = await resolveExistingCheckoutAttempt<typeof responsePayload>(
        db,
        attemptIdentity,
      ).catch((recoveryError: unknown) => {
        console.warn("[Orders] Failed to resolve checkout after an uncertain commit:", recoveryError);
        return null;
      });
      if (recoveredAttempt?.status === "replay") {
        scheduleCheckoutSuccessRecoveryHints(
          c.env,
          recoveredAttempt.response.statusToken,
          recoveredAttempt.response.receiptToken,
          recoveredAttempt.response.orderId,
          executionCtx,
        );
        return created(c, recoveredAttempt.response);
      }
      if (recoveredAttempt?.status === "processing") {
        return c.json({
          success: true,
          data: {
            statusToken: recoveredAttempt.statusToken,
            orderId: recoveredAttempt.orderId,
            status: "processing" as const,
            message: "Order creation is already processing.",
          },
        }, 202);
      }
      scheduleCheckoutFailureStatusHint(
        c.env,
        checkoutAttempt.statusToken,
        result.orderId,
        commitError instanceof ValidationError
          ? commitError.message
          : "Order creation failed. Please try again.",
        executionCtx,
      );
      throw commitError;
    }
    diagnostics?.mark("commit");

    scheduleCheckoutSuccessRecoveryHints(
      c.env,
      checkoutAttempt.statusToken,
      result.checkoutToken,
      result.orderId,
      executionCtx,
    );

    const postCommit = Promise.all([
      availabilityTransitionVariantIds.length > 0 ? bumpCacheGeneration(c) : null,
      runStorefrontOrderPostCommitSideEffects(db, c.env, result.commitPayload),
      // An order fully paid at commit (e.g. covered by gift cards) is settled now.
      result.commitPayload.orderData.paymentStatus === PaymentStatus.PAID
        ? enqueueOrderAutoFulfil(c.env.JOBS_QUEUE, result.orderId, "checkout-commit")
        : null,
    ]);
    if (executionCtx && typeof executionCtx.waitUntil === "function") {
      executionCtx.waitUntil(postCommit);
    } else {
      await postCommit;
    }

    diagnostics?.mark("post_commit");
    diagnostics?.apply(c);

    return created(c, responsePayload);
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      throw new ValidationError("Invalid input data", error.issues);
    }

    throw error;
  }
});

export { app as checkoutRoutes };
