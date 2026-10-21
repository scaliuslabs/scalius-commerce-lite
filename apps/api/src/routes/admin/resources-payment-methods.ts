// Saved payment methods and payments without the buyer in the stable app API
// (operation-registry/README.md), mounted at /admin/resources: what a
// subscriptions or B2B app needs from core, and nothing of its own logic.
//
// - `payment_methods.list` / `payment_methods.delete`: a customer's methods
//   kept by their providers. The provider's reference never leaves the store:
//   an app sees the method id, the provider, brand, last four digits, expiry
//   and label, and only the methods kept for its own purchase options.
// - Every operation here needs the Sensitive `write_payment_methods`
//   (orders.charge_saved_methods), not `write_payments` (security audit N3);
//   an app charges only a method it owns.
// - `payments.charge`: charges a saved method for an order with money due,
//   off-session; `capture: "manual"` only authorizes.
// - `payments.capture` / `payments.void`: settle or release an authorization.
//
// Every write is financial and takes the required Idempotency-Key: the core
// command (payments/saved-method-charges.ts) claims locally before the
// provider call, passes a key derived from it as the provider's idempotency
// key and records the outcome, so a repeat answers the first outcome and
// never charges twice. A decline is 422 `payment_declined`; a lost provider
// answer is 503 `payment_outcome_unknown` (repeat the same request).
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { customers } from "@scalius/database/schema";
import { MAX_MINOR_AMOUNT } from "@scalius/shared/money";
import {
  CUSTOMER_PAYMENT_METHODS_LIST_LIMIT,
  captureAuthorizedPayment,
  chargeSavedPaymentMethod,
  listCustomerPaymentMethods,
  removeCustomerPaymentMethod,
  voidAuthorizedPayment,
  type ApplyProviderPaymentEvent,
  type CustomerPaymentMethodView,
  type PaymentProvidersSource,
  type SavedMethodActor,
  type SavedMethodPaymentOutcome,
} from "@scalius/core/modules/payments";
import { EVENT_REPRESENTATION_SCHEMAS } from "@scalius/shared/events";
import { AppError, NotFoundError } from "../../utils/api-error";
import { created, ok } from "../../utils/api-response";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import { conflictResponse, errorResponses, namedSharedSchema, serviceUnavailableResponse, successEnvelope } from "../../schemas/responses";
import { boundedPage, boundedPageQuery, nextCursorSchema } from "../../utils/bounded-page";
import { readPaymentRepresentation } from "../../events/representations";
import { requestPaymentProviders } from "../../plugins/providers/payment";
import { claimAndApplyPaymentEventNow } from "../payment/payment-events";
import { executionContextOf } from "../../background/after-response";
import { idempotencyKeyHeaderSchema, scopedRequestKey } from "./idempotency";

const app = new OpenAPIHono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "private, no-store");
});

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const isoTimestamp = z.string().openapi({ format: "date-time" });
const PaymentResource = namedSharedSchema(EVENT_REPRESENTATION_SCHEMAS.payment, "PaymentResource");

const PaymentMethodResource = z.object({
  id: z.string().openapi({ description: "The saved method (`cpm_…`): pass it as `paymentMethodId` to charge it." }),
  customerId: z.string(),
  providerId: z.string().openapi({ description: "The payment provider that keeps it (`<app id>:<provider id>`)." }),
  brand: z.string().nullable().openapi({ description: "The card network or wallet, lower case (`visa`)." }),
  last4: z.string().nullable().openapi({ description: "The last four digits; the full number never reaches the store." }),
  expiryMonth: z.number().int().nullable(),
  expiryYear: z.number().int().nullable(),
  label: z.string().nullable(),
  status: z.enum(["active", "removed"]),
  sourceOrderId: z.string().nullable().openapi({ description: "The order whose payment kept it." }),
  ownerAppId: z.string().nullable().openapi({ description: "The app whose purchase option the buyer kept it for: the only app that may charge it (null: only staff may). An app lists and charges only its own." }),
  purchaseOptionId: z.string().nullable().openapi({ description: "That purchase option (`<app id>.<key>`), when the order named exactly one." }),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
}).openapi("PaymentMethodResource");

/**
 * A charge, capture or void answers the order payment (`{ payment }`, null
 * while the provider has not answered) with the attempt's outcome beside it
 * (audit L1: a write answers its resource).
 */
const paymentOutcomeSchema = z.object({
  outcome: z.enum(["succeeded", "authorized", "pending", "voided"]).openapi({
    description: "`succeeded`: captured and credited to the order. `authorized`: held, capture it with payments.capture. `pending`: the provider answers later by webhook; read the order. `voided`: the hold was released.",
  }),
  orderId: z.string(),
  providerId: z.string(),
  amountMinor: z.number().int().openapi({ description: "In minor units of `currency`." }),
  currency: z.string().length(3),
  payment: PaymentResource.nullable().openapi({ description: "The order payment, once the provider's answer landed." }),
  replayed: z.boolean().openapi({ description: "True when this answers a request already handled (the same Idempotency-Key, or an authorization already settled)." }),
});

function methodResource(method: CustomerPaymentMethodView): z.infer<typeof PaymentMethodResource> {
  return {
    id: method.id,
    customerId: method.customerId,
    providerId: method.providerId,
    brand: method.brand,
    last4: method.last4,
    expiryMonth: method.expiryMonth,
    expiryYear: method.expiryYear,
    label: method.label,
    status: method.status,
    sourceOrderId: method.sourceOrderId,
    ownerAppId: method.ownerPluginId,
    purchaseOptionId: method.purchaseOptionId,
    createdAt: iso(method.createdAt),
    updatedAt: iso(method.updatedAt),
  };
}

const requiredKeyHeaders = z.object({
  "idempotency-key": idempotencyKeyHeaderSchema.shape["idempotency-key"].unwrap().openapi({
    description: "Required: one key is one payment attempt; a repeat answers its first outcome and never charges twice.",
  }),
});

const writeResponses = {
  ...errorResponses,
  422: { description: "Declined by the provider (`payment_declined`), or a key reused for another request", content: { "application/json": { schema: errorResponses[400].content["application/json"].schema } } },
  409: conflictResponse,
  503: serviceUnavailableResponse,
};

/**
 * Who asks, from the request's principal (security audit N3): an app reaches
 * only the methods kept for its own purchase options; staff and agents
 * acting for them reach every method.
 */
function actorOf(c: Context<{ Bindings: Env }>): Exclude<SavedMethodActor, { kind: "customer" }> {
  const plugin = c.get("pluginPrincipal");
  return plugin ? { kind: "app", pluginId: plugin.pluginId } : { kind: "staff" };
}

/** The command's dependencies: the request's gateways, credentials and the one event claim. */
function deps(c: Context<{ Bindings: Env }>): { providers: PaymentProvidersSource; encryptionKey: string | undefined; applyEvent: ApplyProviderPaymentEvent } {
  const db = c.get("db");
  return {
    providers: () => requestPaymentProviders(c),
    encryptionKey: getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>),
    applyEvent: ({ provider, event, source }) =>
      claimAndApplyPaymentEventNow({ db, env: c.env, ctx: executionContextOf(c), provider, event, source }),
  };
}

async function outcomeBody(c: Context, outcome: SavedMethodPaymentOutcome) {
  if (outcome.outcome === "declined") {
    throw new AppError(422, "payment_declined", outcome.declineReason ?? "The provider declined the payment.", {
      ...(outcome.declineCode ? { declineCode: outcome.declineCode } : {}),
      orderId: outcome.orderId,
    });
  }
  const payment = outcome.paymentId ? await readPaymentRepresentation(c.get("db"), outcome.paymentId) : null;
  return {
    outcome: outcome.outcome,
    orderId: outcome.orderId,
    providerId: outcome.providerId,
    amountMinor: outcome.amountMinor,
    currency: outcome.currency,
    payment: payment ?? null,
    replayed: outcome.replayed,
  };
}

app.openapi(createRoute({
  operationId: "dashboard.resources.payment_methods.list",
  method: "get",
  path: "/payment-methods",
  tags: ["App API - Payments"],
  summary: "List a customer's saved payment methods",
  description: "The customer's active payment methods kept by their providers (a card or wallet saved with a subscription's first payment), oldest first, at most 50. An app sees only the methods kept for its own purchase options. The provider's own reference never leaves the store.",
  request: { query: z.object({ customerId: z.string().min(1).max(128), ...boundedPageQuery(CUSTOMER_PAYMENT_METHODS_LIST_LIMIT) }) },
  responses: {
    200: { description: "The saved methods, oldest first", content: { "application/json": { schema: successEnvelope(z.object({ paymentMethods: z.array(PaymentMethodResource), nextCursor: nextCursorSchema })) } } },
    ...errorResponses,
  },
}), async (c) => {
  const db = c.get("db");
  const { customerId } = c.req.valid("query");
  const customer = await db.select({ id: customers.id }).from(customers).where(and(eq(customers.id, customerId), isNull(customers.deletedAt))).get();
  if (!customer) throw new NotFoundError("Customer not found");
  const query = c.req.valid("query");
  const page = boundedPage((await listCustomerPaymentMethods(db, customerId, actorOf(c))).map(methodResource), {
    name: "payment_methods",
    cursor: query.cursor,
    limit: query.limit,
    id: (method) => method.id,
    sort: { kind: "text", value: (method) => method.createdAt },
  });
  return ok(c, { paymentMethods: page.items, nextCursor: page.nextCursor });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.payment_methods.delete",
  method: "delete",
  path: "/payment-methods/{id}",
  tags: ["App API - Payments"],
  summary: "Remove a saved payment method",
  description: "Detaches the method at its provider, then removes it: it can no longer be charged. A repeat returns the removed method. Send an Idempotency-Key.",
  request: { params: z.object({ id: z.string().min(1).max(128) }), headers: requiredKeyHeaders },
  responses: {
    200: { description: "The removed method", content: { "application/json": { schema: successEnvelope(z.object({ paymentMethod: PaymentMethodResource })) } } },
    ...writeResponses,
  },
}), async (c) => {
  const removed = await removeCustomerPaymentMethod(c.get("db"), {
    methodId: c.req.valid("param").id,
    actor: actorOf(c),
    ...deps(c),
  });
  return ok(c, { paymentMethod: methodResource(removed) });
});

const chargeBody = z.object({
  paymentMethodId: z.string().min(1).max(128).openapi({ description: "A saved method of the order's customer (payment_methods.list)." }),
  amountMinor: z.number().int().min(1).max(MAX_MINOR_AMOUNT).optional().openapi({
    description: "What to charge, in minor units of the order's `currency`. Default: its `balanceDueMinor`; another amount must be one the order takes (a deposit).",
  }),
  capture: z.enum(["automatic", "manual"]).default("automatic").openapi({
    description: "`manual` only authorizes (money held): capture it with payments.capture or release it with payments.void. Needs a provider that authorizes.",
  }),
  expectedRevision: z.number().int().min(1).optional().openapi({ description: "The order `revision` you read; a different one is refused with 409 before the provider is called." }),
}).strict();

app.openapi(createRoute({
  operationId: "dashboard.resources.payments.charge",
  method: "post",
  path: "/orders/{id}/payments/charge",
  tags: ["App API - Payments"],
  summary: "Charge a customer's saved payment method for an order",
  description: "Charges the order's customer's saved payment method without the buyer (a subscription renewal). An app may charge only a method kept for its own purchase option (`ownerAppId`); any other reads as 404. The order must have money due, not be cancelled, and take a provider payment (its own provider, or an invoice with nothing paid yet, which the payment switches to the provider). The payment lands through the same kernel as a webhook: `payment.updated`, and `order.paid` once nothing is due. A decline is 422 `payment_declined`. When the provider gave no answer, 503 `payment_outcome_unknown`: send the same request again with the same Idempotency-Key; until then the order takes no other charge. Amounts are minor units of the order's currency.",
  request: {
    params: z.object({ id: z.string().min(1).max(128) }),
    headers: requiredKeyHeaders,
    body: { required: true, content: { "application/json": { schema: chargeBody } } },
  },
  responses: {
    201: { description: "The outcome", content: { "application/json": { schema: successEnvelope(paymentOutcomeSchema) } } },
    ...writeResponses,
  },
}), async (c) => {
  const body = c.req.valid("json");
  const outcome = await chargeSavedPaymentMethod(c.get("db"), {
    orderId: c.req.valid("param").id,
    paymentMethodId: body.paymentMethodId,
    actor: actorOf(c),
    ...(body.amountMinor !== undefined ? { amountMinor: body.amountMinor } : {}),
    capture: body.capture,
    ...(body.expectedRevision !== undefined ? { expectedVersion: body.expectedRevision } : {}),
    requestKey: await scopedRequestKey(c, "dashboard.resources.payments.charge", c.req.valid("header")["idempotency-key"]),
    ...deps(c),
  });
  return created(c, await outcomeBody(c, outcome));
});

const paymentIdParam = z.object({ id: z.string().min(1).max(128).openapi({ description: "The authorized payment's id (payments.list)." }) });

app.openapi(createRoute({
  operationId: "dashboard.resources.payments.capture",
  method: "post",
  path: "/payments/{id}/capture",
  tags: ["App API - Payments"],
  summary: "Capture an authorized payment",
  description: "Captures an authorization in full: the payment becomes `succeeded` and is credited to its order (`payment.updated`, `order.paid` once nothing is due). One capture per authorization whatever the key: a repeat answers the first outcome. Send an Idempotency-Key.",
  request: { params: paymentIdParam, headers: requiredKeyHeaders },
  responses: {
    200: { description: "The outcome", content: { "application/json": { schema: successEnvelope(paymentOutcomeSchema) } } },
    ...writeResponses,
  },
}), async (c) => {
  const outcome = await captureAuthorizedPayment(c.get("db"), { paymentId: c.req.valid("param").id, ...deps(c) });
  return ok(c, await outcomeBody(c, outcome));
});

app.openapi(createRoute({
  operationId: "dashboard.resources.payments.void",
  method: "post",
  path: "/payments/{id}/void",
  tags: ["App API - Payments"],
  summary: "Void an authorized payment",
  description: "Releases an authorization at its provider: the payment becomes `cancelled` (`payment.updated`) and the order stays unpaid. A captured payment is refunded instead. Send an Idempotency-Key.",
  request: { params: paymentIdParam, headers: requiredKeyHeaders },
  responses: {
    200: { description: "The outcome", content: { "application/json": { schema: successEnvelope(paymentOutcomeSchema) } } },
    ...writeResponses,
  },
}), async (c) => {
  const outcome = await voidAuthorizedPayment(c.get("db"), { paymentId: c.req.valid("param").id, ...deps(c) });
  return ok(c, await outcomeBody(c, outcome));
});

export { app as adminResourcePaymentMethodRoutes };
