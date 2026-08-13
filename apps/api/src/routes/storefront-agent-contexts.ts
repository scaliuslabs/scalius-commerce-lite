import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  closeAgentStorefrontContext,
  createAgentStorefrontContinuation,
  createAgentStorefrontOrderSupportRequest,
  createAgentStorefrontContext,
  getAgentStorefrontCustomerOrder,
  getAgentStorefrontCustomerProfile,
  getAgentStorefrontCart,
  getAgentStorefrontContext,
  getAgentStorefrontContinuationStatus,
  getAgentStorefrontOrderAccess,
  getAgentStorefrontReceipt,
  listAgentStorefrontCustomerOrders,
  logoutAgentStorefrontCustomer,
  mutateAgentStorefrontCart,
  quoteAgentStorefrontCheckout,
  refreshAgentStorefrontPaymentContinuation,
  setAgentStorefrontDelivery,
  setAgentStorefrontDiscount,
  submitAgentStorefrontCheckout,
  updateAgentStorefrontCustomerProfile,
  validateAgentStorefrontCheckout,
} from "@scalius/core/modules/agent-storefront";
import { ForbiddenError, ValidationError } from "@scalius/core/errors";
import {
  getOrderSupportRequestStatusLabel,
  runStorefrontOrderPostCommitSideEffects,
} from "@scalius/core/modules/orders";
import { phoneNumberSchema } from "@scalius/shared/customer-utils";
import type { AgentPrincipal } from "../agent-access/types";
import { created, ok } from "../utils/api-response";
import {
  conflictResponse,
  errorResponses,
  serviceUnavailableResponse,
  successEnvelope,
} from "../schemas/responses";
import { getCredentialEncryptionKey } from "../utils/encryption-key";
import {
  getOptionalExecutionContext,
  invalidateProductAvailabilityCaches,
} from "../utils/cache-invalidation";
import { enqueueOrderSupportRequestNotificationForOrder } from "../utils/order-notification-queue";

const app = new OpenAPIHono<{ Bindings: Env }>();

const contextIdSchema = z.string().regex(/^asc_[A-Za-z0-9_-]{20}$/);
const continuationIdSchema = z.string().regex(/^acn_[A-Za-z0-9_-]{20}$/);
const variantIdSchema = z.string().trim().min(1).max(180).refine((value) => value !== "default");
const revisionSchema = z.number().int().min(1);
const quantitySchema = z.number().int().min(1).max(99);
const checkoutIdempotencyKeySchema = z.string()
  .trim()
  .min(16)
  .max(64)
  .regex(/^[A-Za-z0-9:_-]+$/);
const checkoutIdempotencyHeadersSchema = z.object({
  "idempotency-key": checkoutIdempotencyKeySchema.optional().openapi({
    description: "Standard retry key. May replace body.idempotencyKey; if both are sent they must match.",
  }),
});

const cartLineSchema = z.object({
  variantId: variantIdSchema,
  quantity: quantitySchema,
});

const contextSchema = z.object({
  id: contextIdSchema,
  status: z.enum(["active", "closed", "expired", "revoked"]),
  revision: revisionSchema,
  cart: z.array(cartLineSchema).max(99),
  discountCode: z.string().nullable(),
  delivery: z.object({
    cityId: z.string().nullable(),
    zoneId: z.string().nullable(),
    areaId: z.string().nullable(),
    shippingMethodId: z.string().nullable(),
  }),
  customerAuthorized: z.boolean(),
  expiresAt: z.string(),
  lastUsedAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const cartIssueSchema = z.object({
  index: z.number().int(),
  cartKey: z.string().nullable().optional(),
  productId: z.string(),
  variantId: z.string().nullable(),
  code: z.string(),
  action: z.string(),
  message: z.string(),
  productName: z.string().nullable(),
  variantLabel: z.string().nullable(),
  requestedQuantity: z.number().int(),
  availableQuantity: z.number().optional(),
  submittedPrice: z.number().optional(),
  currentPrice: z.number().optional(),
});

const cartItemSchema = z.object({
  index: z.number().int(),
  cartKey: z.string().nullable().optional(),
  productId: z.string(),
  variantId: z.string(),
  quantity: z.number().int(),
  unitPrice: z.number(),
  productName: z.string(),
  variantLabel: z.string().nullable(),
  freeDelivery: z.boolean(),
  inventoryTracked: z.boolean(),
  availableQuantity: z.number().nullable(),
  taxClassId: z.string().nullable(),
  productImageMediaId: z.string().nullable(),
  productImage: z.string().nullable(),
});

const cartProjectionSchema = z.object({
  context: contextSchema,
  valid: z.boolean(),
  issues: z.array(cartIssueSchema),
  items: z.array(cartItemSchema),
  subtotal: z.number(),
  hasFreeDeliveryProduct: z.boolean(),
  delivery: z.object({
    shippingCharge: z.number(),
    cityName: z.string(),
    zoneName: z.string(),
    areaName: z.string().nullable(),
  }).optional(),
});

const agentCustomerPhoneSchema = phoneNumberSchema.openapi({
  description: "Customer phone number. Use international E.164 form to avoid country ambiguity (for example, +8801712345678).",
  example: "+8801712345678",
});

const checkoutInputSchema = z.object({
  customerPhone: agentCustomerPhoneSchema.optional().nullable(),
}).strict();

const checkoutQuoteSchema = z.object({
  valid: z.literal(true),
  contextRevision: revisionSchema,
  quoteFingerprint: z.string().regex(/^taxq_[A-Za-z0-9_-]{22}$/),
  displayLabel: z.string(),
  pricesIncludeTax: z.boolean(),
  shippingTaxed: z.boolean(),
  currencyCode: z.string(),
  decimalPlaces: z.number().int().nonnegative(),
  settingsVersion: z.number().int().nonnegative(),
  subtotalMinor: z.number().int().nonnegative(),
  subtotalAmount: z.number().nonnegative(),
  shippingMinor: z.number().int().nonnegative(),
  shippingAmount: z.number().nonnegative(),
  discountMinor: z.number().int().nonnegative(),
  discountAmount: z.number().nonnegative(),
  taxMinor: z.number().int().nonnegative(),
  taxAmount: z.number().nonnegative(),
  totalMinor: z.number().int().nonnegative(),
  totalAmount: z.number().nonnegative(),
  items: z.array(z.object({
    productId: z.string(),
    variantId: z.string(),
    quantity: quantitySchema,
    unitPrice: z.number().nonnegative(),
    productName: z.string(),
    variantLabel: z.string().nullable(),
  })).max(99),
});

const continuationViewSchema = z.object({
  id: continuationIdSchema,
  kind: z.enum(["customer_auth", "payment", "payment_recovery"]),
  status: z.enum(["pending", "complete", "expired", "failed"]),
  expiresAt: z.string(),
});

const startedContinuationSchema = continuationViewSchema.extend({
  browser: z.object({
    url: z.string().url().max(512),
    method: z.literal("POST"),
    fields: z.object({
      continuationCode: z.string().length(68)
        .regex(/^acb_[A-Za-z0-9_-]{20}_[A-Za-z0-9_-]{43}$/),
    }).strict(),
  }).strict(),
  message: z.string().max(256),
});

const checkoutSubmitSchema = z.object({
  expectedRevision: revisionSchema,
  idempotencyKey: checkoutIdempotencyKeySchema.optional(),
  customerName: z.string().trim().min(3).max(100),
  customerPhone: agentCustomerPhoneSchema,
  customerEmail: z.email().nullable(),
  shippingAddress: z.string().trim().min(10).max(500),
  notes: z.string().trim().max(500).nullable(),
  paymentMethod: z.enum(["cod", "stripe", "sslcommerz", "polar"]).openapi({
    description: "Selected active checkout payment method. Online methods continue through storefront.orders.payment.begin.",
  }),
}).strict();

function resolveCheckoutIdempotencyKey(
  headerKey: string | undefined,
  bodyKey: string | undefined,
): string {
  if (headerKey && bodyKey && headerKey !== bodyKey) {
    throw new ValidationError("Idempotency-Key header must match body.idempotencyKey.");
  }
  const idempotencyKey = headerKey ?? bodyKey;
  if (!idempotencyKey) {
    throw new ValidationError("Idempotency-Key header or body.idempotencyKey is required.");
  }
  return idempotencyKey;
}

const checkoutSubmitViewSchema = z.object({
  status: z.enum(["complete", "processing"]),
  contextRevision: revisionSchema,
  orderId: z.string(),
  orderStatus: z.string().optional(),
  paymentMethod: z.string().optional(),
  paymentStatus: z.string().optional(),
  totalAmount: z.number().optional(),
  totalAmountMinor: z.number().int().optional(),
  taxAmount: z.number().optional(),
  taxAmountMinor: z.number().int().optional(),
  taxLabel: z.string().optional(),
  pricesIncludeTax: z.boolean().optional(),
  currencyCode: z.string().optional(),
  decimalPlaces: z.number().int().optional(),
  message: z.string(),
});

const orderPathSchema = z.object({
  contextId: contextIdSchema,
  orderId: z.string().trim().min(1).max(128),
});

const continuationStatusPathSchema = z.object({
  contextId: contextIdSchema,
  continuationId: continuationIdSchema,
});

const profileUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  address: z.string().trim().max(500).optional(),
  city: z.string().trim().max(180).optional(),
  zone: z.string().trim().max(180).optional(),
  area: z.string().trim().max(180).optional(),
}).strict();

const supportRequestSchema = z.object({
  type: z.enum(["cancel_pre_shipment", "return", "refund"]),
  reason: z.string().trim().min(3).max(500),
  message: z.string().trim().max(1000).nullable().optional(),
}).strict();

const contextPathSchema = z.object({ contextId: contextIdSchema });
const continuationPathSchema = z.object({
  contextId: contextIdSchema,
  continuationId: continuationIdSchema,
});
const revisionBodySchema = z.object({ revision: revisionSchema }).strict();
const mutationErrors = {
  400: errorResponses[400],
  401: errorResponses[401],
  403: errorResponses[403],
  404: errorResponses[404],
  409: conflictResponse,
  500: errorResponses[500],
};
const readErrors = {
  401: errorResponses[401],
  403: errorResponses[403],
  404: errorResponses[404],
  409: conflictResponse,
  500: errorResponses[500],
};

function requireStorefrontPrincipal(c: { get(key: "agentPrincipal"): AgentPrincipal }): AgentPrincipal {
  const principal = c.get("agentPrincipal");
  if (!principal || principal.kind !== "agent" || principal.resource !== "storefront") {
    throw new ForbiddenError("A storefront agent connection is required.");
  }
  return principal;
}

function noStore(c: { header(name: string, value: string): void }): void {
  c.header("Cache-Control", "private, no-store");
}

function continuationBootstrap(env: Env, continuationCode: string) {
  const base = env.STOREFRONT_URL?.trim();
  if (!base) throw new ForbiddenError("The storefront continuation origin is not configured.");
  const url = new URL("/checkout/continue", base);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new ForbiddenError("The storefront continuation origin is invalid.");
  }
  return {
    url: url.toString(),
    method: "POST" as const,
    fields: { continuationCode },
  };
}

const createContextRoute = createRoute({
  method: "post",
  path: "/",
  operationId: "storefront.context.create",
  tags: ["Storefront Agent Contexts"],
  summary: "Create a relational storefront agent context",
  responses: {
    201: { description: "Context created", content: { "application/json": { schema: successEnvelope(contextSchema) } } },
    401: errorResponses[401],
    403: errorResponses[403],
    500: errorResponses[500],
  },
});

app.openapi(createContextRoute, async (c) => {
  noStore(c);
  const principal = requireStorefrontPrincipal(c);
  return created(c, await createAgentStorefrontContext(c.get("db"), principal.grantId, {
    maximumExpiresAt: principal.expiresAt,
  }));
});

const getContextRoute = createRoute({
  method: "get",
  path: "/{contextId}",
  operationId: "storefront.context.get",
  tags: ["Storefront Agent Contexts"],
  summary: "Get current storefront context state",
  request: { params: contextPathSchema },
  responses: {
    200: { description: "Context state", content: { "application/json": { schema: successEnvelope(contextSchema) } } },
    ...readErrors,
  },
});

app.openapi(getContextRoute, async (c) => {
  noStore(c);
  const principal = requireStorefrontPrincipal(c);
  return ok(c, await getAgentStorefrontContext(
    c.get("db"),
    principal.grantId,
    c.req.valid("param").contextId,
  ));
});

const closeContextRoute = createRoute({
  method: "post",
  path: "/{contextId}/close",
  operationId: "storefront.context.close",
  tags: ["Storefront Agent Contexts"],
  summary: "Close a storefront context",
  request: {
    params: contextPathSchema,
    body: { required: true, content: { "application/json": { schema: revisionBodySchema } } },
  },
  responses: {
    200: { description: "Closed context", content: { "application/json": { schema: successEnvelope(contextSchema) } } },
    ...mutationErrors,
  },
});

app.openapi(closeContextRoute, async (c) => {
  noStore(c);
  const principal = requireStorefrontPrincipal(c);
  return ok(c, await closeAgentStorefrontContext(
    c.get("db"),
    principal.grantId,
    c.req.valid("param").contextId,
    c.req.valid("json").revision,
  ));
});

const getCartRoute = createRoute({
  method: "get",
  path: "/{contextId}/cart",
  operationId: "storefront.cart.get",
  tags: ["Storefront Agent Contexts"],
  summary: "Rehydrate and validate the current storefront cart",
  request: { params: contextPathSchema },
  responses: {
    200: { description: "Authoritative cart", content: { "application/json": { schema: successEnvelope(cartProjectionSchema) } } },
    ...readErrors,
  },
});

app.openapi(getCartRoute, async (c) => {
  noStore(c);
  const principal = requireStorefrontPrincipal(c);
  return ok(c, await getAgentStorefrontCart(c.get("db"), principal.grantId, c.req.valid("param").contextId));
});

function cartMutationRoute<T extends z.ZodRawShape>(
  method: "post" | "put" | "patch" | "delete",
  path: string,
  operationId: string,
  summary: string,
  bodySchema: z.ZodObject<T>,
) {
  return createRoute({
    method,
    path,
    operationId,
    tags: ["Storefront Agent Contexts"],
    summary,
    request: {
      params: contextPathSchema,
      body: { required: true, content: { "application/json": { schema: bodySchema } } },
    },
    responses: {
      200: { description: "Updated authoritative cart", content: { "application/json": { schema: successEnvelope(cartProjectionSchema) } } },
      ...mutationErrors,
    },
  });
}

const addCartLineRoute = cartMutationRoute(
  "post",
  "/{contextId}/cart/items",
  "storefront.cart.add",
  "Add a persisted variant to the storefront cart",
  z.object({ revision: revisionSchema, variantId: variantIdSchema, quantity: quantitySchema }).strict(),
);
app.openapi(addCartLineRoute, async (c) => {
  noStore(c);
  const principal = requireStorefrontPrincipal(c);
  const input = c.req.valid("json");
  return ok(c, await mutateAgentStorefrontCart(
    c.get("db"), principal.grantId, c.req.valid("param").contextId, input.revision,
    { kind: "add", variantId: input.variantId, quantity: input.quantity },
  ));
});

const setCartLineRoute = cartMutationRoute(
  "patch",
  "/{contextId}/cart/items",
  "storefront.cart.set_quantity",
  "Set storefront cart quantity",
  z.object({ revision: revisionSchema, variantId: variantIdSchema, quantity: quantitySchema }).strict(),
);
app.openapi(setCartLineRoute, async (c) => {
  noStore(c);
  const principal = requireStorefrontPrincipal(c);
  const input = c.req.valid("json");
  return ok(c, await mutateAgentStorefrontCart(
    c.get("db"), principal.grantId, c.req.valid("param").contextId, input.revision,
    { kind: "set", variantId: input.variantId, quantity: input.quantity },
  ));
});

const removeCartLineRoute = cartMutationRoute(
  "delete",
  "/{contextId}/cart/items",
  "storefront.cart.remove",
  "Remove a variant from the storefront cart",
  z.object({ revision: revisionSchema, variantId: variantIdSchema }).strict(),
);
app.openapi(removeCartLineRoute, async (c) => {
  noStore(c);
  const principal = requireStorefrontPrincipal(c);
  const input = c.req.valid("json");
  return ok(c, await mutateAgentStorefrontCart(
    c.get("db"), principal.grantId, c.req.valid("param").contextId, input.revision,
    { kind: "remove", variantId: input.variantId },
  ));
});

const clearCartRoute = cartMutationRoute(
  "delete",
  "/{contextId}/cart",
  "storefront.cart.clear",
  "Clear the storefront cart",
  revisionBodySchema,
);
app.openapi(clearCartRoute, async (c) => {
  noStore(c);
  const principal = requireStorefrontPrincipal(c);
  return ok(c, await mutateAgentStorefrontCart(
    c.get("db"), principal.grantId, c.req.valid("param").contextId, c.req.valid("json").revision,
    { kind: "clear" },
  ));
});

const applyDiscountRoute = cartMutationRoute(
  "put",
  "/{contextId}/discount",
  "storefront.discount.apply",
  "Apply a storefront discount code",
  z.object({
    revision: revisionSchema,
    code: z.string().trim().min(1).max(100),
    customerPhone: phoneNumberSchema.optional().nullable(),
  }).strict(),
);
app.openapi(applyDiscountRoute, async (c) => {
  noStore(c);
  const principal = requireStorefrontPrincipal(c);
  const input = c.req.valid("json");
  return ok(c, await setAgentStorefrontDiscount(
    c.get("db"), principal.grantId, c.req.valid("param").contextId, input.revision, input.code,
    { customerPhone: input.customerPhone },
  ));
});

const removeDiscountRoute = cartMutationRoute(
  "delete",
  "/{contextId}/discount",
  "storefront.discount.remove",
  "Remove the storefront discount code",
  revisionBodySchema,
);
app.openapi(removeDiscountRoute, async (c) => {
  noStore(c);
  const principal = requireStorefrontPrincipal(c);
  return ok(c, await setAgentStorefrontDiscount(
    c.get("db"), principal.grantId, c.req.valid("param").contextId, c.req.valid("json").revision, null,
  ));
});

const setDeliveryRoute = cartMutationRoute(
  "put",
  "/{contextId}/delivery",
  "storefront.delivery.set",
  "Set and validate storefront delivery selection",
  z.object({
    revision: revisionSchema,
    cityId: z.string().trim().min(1).max(180).nullable(),
    zoneId: z.string().trim().min(1).max(180).nullable(),
    areaId: z.string().trim().min(1).max(180).nullable(),
    shippingMethodId: z.string().trim().min(1).max(180).nullable(),
  }).strict(),
);
app.openapi(setDeliveryRoute, async (c) => {
  noStore(c);
  const principal = requireStorefrontPrincipal(c);
  const { revision, ...delivery } = c.req.valid("json");
  return ok(c, await setAgentStorefrontDelivery(
    c.get("db"), principal.grantId, c.req.valid("param").contextId, revision, delivery,
  ));
});

const validateCheckoutRoute = createRoute({
  method: "post",
  path: "/{contextId}/checkout/validate",
  operationId: "storefront.checkout.validate",
  tags: ["Storefront Agent Contexts"],
  summary: "Validate authoritative cart and delivery state before checkout",
  request: {
    params: contextPathSchema,
    body: { required: true, content: { "application/json": { schema: checkoutInputSchema } } },
  },
  responses: {
    200: { description: "Validated checkout state", content: { "application/json": { schema: successEnvelope(cartProjectionSchema) } } },
    400: errorResponses[400],
    ...readErrors,
  },
});
app.openapi(validateCheckoutRoute, async (c) => {
  noStore(c);
  const principal = requireStorefrontPrincipal(c);
  return ok(c, await validateAgentStorefrontCheckout(
    c.get("db"),
    principal.grantId,
    c.req.valid("param").contextId,
    { customerPhone: c.req.valid("json").customerPhone },
  ));
});

const quoteCheckoutRoute = createRoute({
  method: "post",
  path: "/{contextId}/checkout/quote",
  operationId: "storefront.checkout.quote",
  tags: ["Storefront Agent Contexts"],
  summary: "Quote current cart, discount, delivery, and tax authority",
  request: {
    params: contextPathSchema,
    body: { required: true, content: { "application/json": { schema: checkoutInputSchema } } },
  },
  responses: {
    200: { description: "Authoritative checkout quote", content: { "application/json": { schema: successEnvelope(checkoutQuoteSchema) } } },
    400: errorResponses[400],
    ...readErrors,
  },
});
app.openapi(quoteCheckoutRoute, async (c) => {
  noStore(c);
  const principal = requireStorefrontPrincipal(c);
  return ok(c, await quoteAgentStorefrontCheckout(
    c.get("db"),
    principal.grantId,
    c.req.valid("param").contextId,
    { customerPhone: c.req.valid("json").customerPhone },
  ));
});

const submitCheckoutRoute = createRoute({
  method: "post",
  path: "/{contextId}/checkout/submit",
  operationId: "storefront.checkout.submit",
  tags: ["Storefront Agent Contexts"],
  summary: "Create an idempotent storefront order and bind order authority",
  request: {
    params: contextPathSchema,
    headers: checkoutIdempotencyHeadersSchema,
    body: { required: true, content: { "application/json": { schema: checkoutSubmitSchema } } },
  },
  responses: {
    200: { description: "Order submit result", content: { "application/json": { schema: successEnvelope(checkoutSubmitViewSchema) } } },
    201: { description: "Order created", content: { "application/json": { schema: successEnvelope(checkoutSubmitViewSchema) } } },
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    409: conflictResponse,
    500: errorResponses[500],
    503: serviceUnavailableResponse,
  },
});
app.openapi(submitCheckoutRoute, async (c) => {
  noStore(c);
  const principal = requireStorefrontPrincipal(c);
  const contextId = c.req.valid("param").contextId;
  const { idempotencyKey: bodyIdempotencyKey, ...checkoutInput } = c.req.valid("json");
  const idempotencyKey = resolveCheckoutIdempotencyKey(
    c.req.valid("header")["idempotency-key"],
    bodyIdempotencyKey,
  );
  const submitted = await submitAgentStorefrontCheckout(
    c.get("db"),
    principal.grantId,
    contextId,
    { ...checkoutInput, idempotencyKey },
    {
      requestUrl: new URL(
        `/api/v1/storefront/agent-contexts/${encodeURIComponent(contextId)}/checkout/submit`,
        c.env.PUBLIC_API_BASE_URL,
      ).toString(),
      credentialEncryptionKey: getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>),
    },
  );
  const executionCtx = getOptionalExecutionContext(c);
  if (submitted.postCommitPayload) {
    const postCommit = runStorefrontOrderPostCommitSideEffects(
      c.get("db"),
      c.env,
      submitted.postCommitPayload,
    );
    if (executionCtx) executionCtx.waitUntil(postCommit);
    else await postCommit;
  }
  if (submitted.availabilityVariantIds.length > 0) {
    const invalidation = invalidateProductAvailabilityCaches(
      c.get("db"),
      { variantIds: submitted.availabilityVariantIds },
      c,
    );
    if (executionCtx) executionCtx.waitUntil(invalidation);
    else await invalidation;
  }
  return submitted.response.status === "complete"
    ? created(c, submitted.response)
    : ok(c, submitted.response);
});

function beginContinuationRoute(path: string, operationId: string, summary: string, bodySchema: z.ZodTypeAny) {
  return createRoute({
    method: "post",
    path,
    operationId,
    tags: ["Storefront Agent Contexts"],
    summary,
    request: {
      params: path.includes("{orderId}") ? orderPathSchema : contextPathSchema,
      body: { required: true, content: { "application/json": { schema: bodySchema } } },
    },
    responses: {
      201: { description: "Secure storefront step started", content: { "application/json": { schema: successEnvelope(startedContinuationSchema) } } },
      ...mutationErrors,
    },
  });
}

const beginCustomerAuthRoute = beginContinuationRoute(
  "/{contextId}/customer/auth",
  "storefront.customer_auth.begin",
  "Start secure customer authorization",
  z.object({}).strict(),
);
app.openapi(beginCustomerAuthRoute, async (c) => {
  noStore(c);
  const principal = requireStorefrontPrincipal(c);
  const params = c.req.valid("param");
  const continuation = await createAgentStorefrontContinuation(
    c.get("db"), principal.grantId, params.contextId, { kind: "customer_auth" },
  );
  const { bootstrapCode, ...view } = continuation;
  return created(c, {
    ...view,
    browser: continuationBootstrap(c.env, bootstrapCode),
    message: "Ask the customer to complete authorization in the secure storefront tab.",
  });
});

const customerAuthStatusRoute = createRoute({
  method: "get",
  path: "/{contextId}/customer/auth/{continuationId}",
  operationId: "storefront.customer_auth.status",
  tags: ["Storefront Agent Contexts"],
  summary: "Get safe customer authorization status",
  request: { params: continuationStatusPathSchema },
  responses: {
    200: { description: "Customer authorization status", content: { "application/json": { schema: successEnvelope(z.object({
      id: continuationIdSchema,
      kind: z.literal("customer_auth"),
      status: z.enum(["pending", "complete", "expired", "failed"]),
      expiresAt: z.string(),
      result: z.record(z.string(), z.unknown()).nullable(),
      message: z.string(),
    })) } } },
    ...readErrors,
  },
});
app.openapi(customerAuthStatusRoute, async (c) => {
  noStore(c);
  const principal = requireStorefrontPrincipal(c);
  const params = c.req.valid("param");
  const status = await getAgentStorefrontContinuationStatus(
    c.get("db"), principal.grantId, params.contextId, params.continuationId,
  );
  if (status.kind !== "customer_auth") throw new ForbiddenError("Continuation kind does not match customer authorization.");
  return ok(c, { ...status, kind: "customer_auth" as const });
});

const logoutCustomerRoute = createRoute({
  method: "post",
  path: "/{contextId}/customer/logout",
  operationId: "storefront.customer_auth.logout",
  tags: ["Storefront Agent Contexts"],
  summary: "Revoke the bound customer session and clear context authority",
  request: {
    params: contextPathSchema,
    body: { required: true, content: { "application/json": { schema: revisionBodySchema } } },
  },
  responses: {
    200: { description: "Customer logged out", content: { "application/json": { schema: successEnvelope(z.object({ revision: revisionSchema, authenticated: z.literal(false) })) } } },
    ...mutationErrors,
  },
});
app.openapi(logoutCustomerRoute, async (c) => {
  noStore(c);
  const principal = requireStorefrontPrincipal(c);
  return ok(c, await logoutAgentStorefrontCustomer(
    c.get("db"), principal.grantId, c.req.valid("param").contextId, c.req.valid("json").revision,
  ));
});

const customerProfileRoute = createRoute({
  method: "get",
  path: "/{contextId}/customer/profile",
  operationId: "storefront.customer_profile.get",
  tags: ["Storefront Agent Contexts"],
  summary: "Get the authorized customer profile",
  request: { params: contextPathSchema },
  responses: {
    200: { description: "Customer profile", content: { "application/json": { schema: successEnvelope(z.object({}).passthrough()) } } },
    ...readErrors,
  },
});
app.openapi(customerProfileRoute, async (c) => {
  noStore(c);
  const principal = requireStorefrontPrincipal(c);
  return ok(c, await getAgentStorefrontCustomerProfile(
    c.get("db"), principal.grantId, c.req.valid("param").contextId,
  ));
});

const updateCustomerProfileRoute = createRoute({
  method: "put",
  path: "/{contextId}/customer/profile",
  operationId: "storefront.customer_profile.update",
  tags: ["Storefront Agent Contexts"],
  summary: "Update the authorized customer delivery profile",
  request: {
    params: contextPathSchema,
    body: { required: true, content: { "application/json": { schema: profileUpdateSchema } } },
  },
  responses: {
    200: { description: "Updated customer profile", content: { "application/json": { schema: successEnvelope(z.object({}).passthrough()) } } },
    ...mutationErrors,
  },
});
app.openapi(updateCustomerProfileRoute, async (c) => {
  noStore(c);
  const principal = requireStorefrontPrincipal(c);
  return ok(c, await updateAgentStorefrontCustomerProfile(
    c.get("db"), principal.grantId, c.req.valid("param").contextId, c.req.valid("json"),
  ));
});

const listCustomerOrdersRoute = createRoute({
  method: "get",
  path: "/{contextId}/customer/orders",
  operationId: "storefront.orders.list",
  tags: ["Storefront Agent Contexts"],
  summary: "List orders owned by the authorized customer",
  request: {
    params: contextPathSchema,
    query: z.object({ cursor: z.string().min(1).optional(), limit: z.coerce.number().int().min(1).max(50).optional() }),
  },
  responses: {
    200: { description: "Customer orders", content: { "application/json": { schema: successEnvelope(z.object({}).passthrough()) } } },
    ...readErrors,
  },
});
app.openapi(listCustomerOrdersRoute, async (c) => {
  noStore(c);
  const principal = requireStorefrontPrincipal(c);
  return ok(c, await listAgentStorefrontCustomerOrders(
    c.get("db"), principal.grantId, c.req.valid("param").contextId, c.req.valid("query"),
  ));
});

const getCustomerOrderRoute = createRoute({
  method: "get",
  path: "/{contextId}/customer/orders/{orderId}",
  operationId: "storefront.orders.get",
  tags: ["Storefront Agent Contexts"],
  summary: "Get an order owned by the authorized customer",
  request: { params: orderPathSchema },
  responses: {
    200: { description: "Customer order", content: { "application/json": { schema: successEnvelope(z.object({}).passthrough()) } } },
    ...readErrors,
  },
});
app.openapi(getCustomerOrderRoute, async (c) => {
  noStore(c);
  const principal = requireStorefrontPrincipal(c);
  const params = c.req.valid("param") as { contextId: string; orderId: string };
  return ok(c, await getAgentStorefrontCustomerOrder(
    c.get("db"), principal.grantId, params.contextId, params.orderId,
  ));
});

const getReceiptRoute = createRoute({
  method: "get",
  path: "/{contextId}/orders/{orderId}/receipt",
  operationId: "storefront.receipt.get",
  tags: ["Storefront Agent Contexts"],
  summary: "Get a safe context-authorized order receipt",
  request: { params: orderPathSchema },
  responses: {
    200: { description: "Order receipt", content: { "application/json": { schema: successEnvelope(z.object({}).passthrough()) } } },
    ...readErrors,
  },
});
app.openapi(getReceiptRoute, async (c) => {
  noStore(c);
  const principal = requireStorefrontPrincipal(c);
  const params = c.req.valid("param") as { contextId: string; orderId: string };
  return ok(c, await getAgentStorefrontReceipt(
    c.get("db"), principal.grantId, params.contextId, params.orderId,
  ));
});

const createSupportRequestRoute = createRoute({
  method: "post",
  path: "/{contextId}/orders/{orderId}/support-requests",
  operationId: "storefront.orders.support_request.create",
  tags: ["Storefront Agent Contexts"],
  summary: "Submit a buyer support request for an authorized order",
  request: {
    params: orderPathSchema,
    body: { required: true, content: { "application/json": { schema: supportRequestSchema } } },
  },
  responses: {
    201: { description: "Support request submitted", content: { "application/json": { schema: successEnvelope(z.object({}).passthrough()) } } },
    ...mutationErrors,
  },
});
app.openapi(createSupportRequestRoute, async (c) => {
  noStore(c);
  const principal = requireStorefrontPrincipal(c);
  const params = c.req.valid("param");
  const result = await createAgentStorefrontOrderSupportRequest(
    c.get("db"), principal.grantId, params.contextId, params.orderId, c.req.valid("json"),
  );
  await enqueueOrderSupportRequestNotificationForOrder({
    db: c.get("db"),
    queue: c.env.ORDER_NOTIFICATIONS_QUEUE,
    orderId: params.orderId,
    requestId: result.request.id,
    notificationType: "support_request_submitted",
    source: "agent-storefront-support-request",
    status: result.request.status,
    data: {
      supportRequestType: result.request.type,
      supportRequestTypeLabel: result.request.label,
      supportRequestStatus: result.request.status,
      supportRequestStatusLabel: getOrderSupportRequestStatusLabel(result.request.status),
    },
  });
  return created(c, result);
});

const beginOrderPaymentRoute = beginContinuationRoute(
  "/{contextId}/orders/{orderId}/payment",
  "storefront.orders.payment.begin",
  "Start secure payment for an authorized order",
  z.object({}).strict(),
);
app.openapi(beginOrderPaymentRoute, async (c) => {
  noStore(c);
  const principal = requireStorefrontPrincipal(c);
  const params = c.req.valid("param") as { contextId: string; orderId: string };
  await getAgentStorefrontOrderAccess(c.get("db"), principal.grantId, params.contextId, params.orderId);
  const continuation = await createAgentStorefrontContinuation(
    c.get("db"), principal.grantId, params.contextId,
    { kind: "payment", orderId: params.orderId },
  );
  const { bootstrapCode, ...view } = continuation;
  return created(c, {
    ...view,
    browser: continuationBootstrap(c.env, bootstrapCode),
    message: "Complete payment in the secure storefront tab.",
  });
});

const paymentStatusRoute = createRoute({
  method: "get",
  path: "/{contextId}/payments/{continuationId}",
  operationId: "storefront.payment.status",
  tags: ["Storefront Agent Contexts"],
  summary: "Get safe hosted-payment status",
  request: { params: continuationStatusPathSchema },
  responses: {
    200: { description: "Payment status", content: { "application/json": { schema: successEnvelope(z.object({}).passthrough()) } },
    },
    ...readErrors,
  },
});
app.openapi(paymentStatusRoute, async (c) => {
  noStore(c);
  const principal = requireStorefrontPrincipal(c);
  const params = c.req.valid("param");
  const owned = await getAgentStorefrontContinuationStatus(
    c.get("db"), principal.grantId, params.contextId, params.continuationId,
  );
  if (owned.kind !== "payment") throw new ForbiddenError("Continuation kind does not match payment.");
  await refreshAgentStorefrontPaymentContinuation(c.get("db"), params.continuationId);
  const status = await getAgentStorefrontContinuationStatus(
    c.get("db"), principal.grantId, params.contextId, params.continuationId,
  );
  return ok(c, { ...status, kind: "payment" as const });
});

const beginPaymentRecoveryRoute = beginContinuationRoute(
  "/{contextId}/orders/{orderId}/payment-recovery",
  "storefront.payment_recovery.begin",
  "Start buyer-verified payment recovery",
  z.object({}).strict(),
);
app.openapi(beginPaymentRecoveryRoute, async (c) => {
  noStore(c);
  const principal = requireStorefrontPrincipal(c);
  const params = c.req.valid("param") as { contextId: string; orderId: string };
  const continuation = await createAgentStorefrontContinuation(
    c.get("db"), principal.grantId, params.contextId,
    { kind: "payment_recovery", orderId: params.orderId },
  );
  const { bootstrapCode, ...view } = continuation;
  return created(c, {
    ...view,
    browser: continuationBootstrap(c.env, bootstrapCode),
    message: "Ask the buyer to verify order access in the secure storefront tab.",
  });
});

const paymentRecoveryStatusRoute = createRoute({
  method: "get",
  path: "/{contextId}/payment-recoveries/{continuationId}",
  operationId: "storefront.payment_recovery.status",
  tags: ["Storefront Agent Contexts"],
  summary: "Get safe payment-recovery status",
  request: { params: continuationStatusPathSchema },
  responses: {
    200: { description: "Payment recovery status", content: { "application/json": { schema: successEnvelope(z.object({}).passthrough()) } } },
    ...readErrors,
  },
});
app.openapi(paymentRecoveryStatusRoute, async (c) => {
  noStore(c);
  const principal = requireStorefrontPrincipal(c);
  const params = c.req.valid("param");
  const status = await getAgentStorefrontContinuationStatus(
    c.get("db"), principal.grantId, params.contextId, params.continuationId,
  );
  if (status.kind !== "payment_recovery") throw new ForbiddenError("Continuation kind does not match payment recovery.");
  return ok(c, status);
});

const getContinuationStatusRoute = createRoute({
  method: "get",
  path: "/{contextId}/continuations/{continuationId}",
  operationId: "storefront.continuations.get",
  tags: ["Storefront Agent Contexts"],
  summary: "Get safe storefront continuation status",
  request: { params: continuationPathSchema },
  responses: {
    200: {
      description: "Safe continuation state",
      content: { "application/json": { schema: successEnvelope(z.object({
        id: continuationIdSchema,
        kind: z.enum(["customer_auth", "payment", "payment_recovery"]),
        status: z.enum(["pending", "complete", "expired", "failed"]),
        expiresAt: z.string(),
        result: z.record(z.string(), z.unknown()).nullable(),
        message: z.string(),
      })) } },
    },
    ...readErrors,
  },
});
app.openapi(getContinuationStatusRoute, async (c) => {
  noStore(c);
  const principal = requireStorefrontPrincipal(c);
  const params = c.req.valid("param");
  return ok(c, await getAgentStorefrontContinuationStatus(
    c.get("db"), principal.grantId, params.contextId, params.continuationId,
  ));
});

export { app as storefrontAgentContextRoutes };
