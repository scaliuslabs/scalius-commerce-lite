import type { Database } from "@scalius/database/client";
import {
  agentStorefrontContexts,
  agentStorefrontContinuations,
  agentStorefrontOrderGrants,
  checkoutAttempts,
  customerSessions,
  customers,
  InventoryPool,
  orders,
  PaymentMethod,
  productVariants,
} from "@scalius/database/schema";
import {
  calculateDiscountAmount,
  isDiscountValid,
} from "@scalius/core/modules/discounts/discounts.eligibility";
import {
  assertGuestStorefrontCheckoutPolicy,
  assertStorefrontCheckoutPolicy,
  buildCheckoutAttemptIdentity,
  commitStorefrontOrderPayload,
  createAtomicCheckoutAttempt,
  createStorefrontOrder,
  createTrustedStorefrontCheckoutPolicySnapshot,
  loadStorefrontCheckoutAuthority,
  resolveExistingCheckoutAttempt,
  type StorefrontOrderCommitPayload,
} from "@scalius/core/modules/orders";
import { getSSLCommerzBdtAmountLimitIssue } from "@scalius/core/modules/payments/sslcommerz";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationError,
} from "../../errors";
import { createAgentStorefrontBootstrap } from "./bootstrap";
import { parseAgentStorefrontCartJson } from "./state";

type ContextRow = typeof agentStorefrontContexts.$inferSelect;

const PAYMENT_CONTINUATION_TTL_MS = 30 * 60 * 1_000;
const CHECKOUT_ATTEMPT_REQUEST_KEY_PREFIX = "checkout_submit:v1:";

export interface AgentStorefrontCheckoutSubmitInput {
  expectedRevision: number;
  idempotencyKey: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  shippingAddress: string;
  notes: string | null;
  paymentMethod: "cod" | "stripe" | "sslcommerz" | "polar";
}

export interface AgentStorefrontCheckoutSubmitView {
  status: "complete" | "processing";
  contextRevision: number;
  orderId: string;
  orderStatus?: string;
  paymentMethod?: string;
  paymentStatus?: string;
  totalAmount?: number;
  totalAmountMinor?: number;
  taxAmount?: number;
  taxAmountMinor?: number;
  taxLabel?: string;
  pricesIncludeTax?: boolean;
  currencyCode?: string;
  decimalPlaces?: number;
  message: string;
}

export interface AgentStorefrontCheckoutSubmitResult {
  response: AgentStorefrontCheckoutSubmitView;
  postCommitPayload: StorefrontOrderCommitPayload | null;
  availabilityVariantIds: string[];
}

function toEpochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1_000);
}

function normalizeIdempotencyKey(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9:_-]{16,64}$/.test(normalized)) {
    throw new ValidationError("Idempotency key must be 16 to 64 URL-safe characters.");
  }
  return normalized;
}

function checkoutRequestId(contextId: string, idempotencyKey: string): string {
  return `agent:${contextId}:${normalizeIdempotencyKey(idempotencyKey)}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function requestKeyForCheckout(requestId: string): Promise<string> {
  return `${CHECKOUT_ATTEMPT_REQUEST_KEY_PREFIX}${await sha256Hex(requestId)}`;
}

async function loadOwnedContext(
  db: Database,
  grantId: string,
  contextId: string,
): Promise<ContextRow> {
  const row = await db.select().from(agentStorefrontContexts)
    .where(eq(agentStorefrontContexts.id, contextId))
    .get();
  if (!row) throw new NotFoundError("Storefront context not found.");
  if (row.grantId !== grantId) throw new ForbiddenError("This connection does not own the storefront context.");
  return row;
}

function assertActiveContext(row: ContextRow, expectedRevision: number, now: Date): void {
  if (row.status !== "active" || row.closedAt) {
    throw new ConflictError("This storefront context is closed.");
  }
  if (row.expiresAt.getTime() <= now.getTime()) {
    throw new ConflictError("This storefront context expired. Start a new context.");
  }
  if (row.revision !== expectedRevision) {
    throw new ConflictError(
      `This storefront context changed from revision ${expectedRevision} to ${row.revision}. Reload it and retry.`,
    );
  }
}

function parseStoredSubmitResponse(value: string | null): AgentStorefrontCheckoutSubmitView | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as AgentStorefrontCheckoutSubmitView;
    if (
      parsed?.status !== "complete"
      || typeof parsed.orderId !== "string"
      || !Number.isInteger(parsed.contextRevision)
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function replayCommittedCheckout(
  db: Database,
  contextId: string,
  requestKey: string,
): Promise<AgentStorefrontCheckoutSubmitView | null> {
  const attempt = await db.select({
    status: checkoutAttempts.status,
    orderId: checkoutAttempts.orderId,
    responsePayload: checkoutAttempts.responsePayload,
  }).from(checkoutAttempts)
    .where(eq(checkoutAttempts.requestKey, requestKey))
    .get();
  if (!attempt) return null;
  if (attempt.status === "processing") {
    const context = await db.select({ revision: agentStorefrontContexts.revision })
      .from(agentStorefrontContexts)
      .where(eq(agentStorefrontContexts.id, contextId))
      .get();
    return {
      status: "processing",
      contextRevision: context?.revision ?? 1,
      orderId: attempt.orderId,
      message: "Order creation is already processing.",
    };
  }
  if (attempt.status !== "committed") return null;
  const grant = await db.select({ orderId: agentStorefrontOrderGrants.orderId })
    .from(agentStorefrontOrderGrants)
    .where(and(
      eq(agentStorefrontOrderGrants.contextId, contextId),
      eq(agentStorefrontOrderGrants.orderId, attempt.orderId),
      gt(agentStorefrontOrderGrants.expiresAt, new Date()),
    ))
    .get();
  if (!grant) {
    throw new ServiceUnavailableError("The committed order authority could not be verified.");
  }
  const response = parseStoredSubmitResponse(attempt.responsePayload);
  if (!response || response.orderId !== attempt.orderId) {
    throw new ServiceUnavailableError("The committed checkout response could not be verified.");
  }
  return response;
}

async function resolveContextCartIdentities(
  db: Database,
  row: ContextRow,
): Promise<Array<{ productId: string; variantId: string; quantity: number }>> {
  const cart = parseAgentStorefrontCartJson(row.cartJson);
  if (cart.length === 0) throw new ValidationError("Add at least one item before checkout.");
  const idsJson = JSON.stringify(cart.map((line) => line.variantId));
  const identities = await db.select({
    variantId: productVariants.id,
    productId: productVariants.productId,
  }).from(productVariants)
    .where(sql`${productVariants.id} IN (
      SELECT CAST(value AS TEXT) FROM json_each(${idsJson})
    )`);
  const byVariant = new Map(identities.map((entry) => [entry.variantId, entry.productId]));
  return cart.map((line) => {
    const productId = byVariant.get(line.variantId);
    if (!productId) throw new ValidationError("A saved cart variant is no longer available.");
    return { productId, variantId: line.variantId, quantity: line.quantity };
  });
}

async function liveContextCustomer(
  db: Database,
  row: ContextRow,
): Promise<{ id: string; phone: string | null } | null> {
  if (!row.customerSessionTokenHash) return null;
  const result = await db.select({ id: customers.id, phone: customers.phone })
    .from(customerSessions)
    .innerJoin(customers, eq(customerSessions.customerId, customers.id))
    .where(and(
      eq(customerSessions.tokenHash, row.customerSessionTokenHash),
      isNull(customerSessions.revokedAt),
      gt(customerSessions.expiresAt, toEpochSeconds(new Date())),
      isNull(customers.deletedAt),
    ))
    .get();
  return result ?? null;
}

function paymentContinuationExpiry(now: Date, contextExpiry: Date): Date {
  return new Date(Math.min(contextExpiry.getTime(), now.getTime() + PAYMENT_CONTINUATION_TTL_MS));
}

export async function submitAgentStorefrontCheckout(
  db: Database,
  grantId: string,
  contextId: string,
  input: AgentStorefrontCheckoutSubmitInput,
  options: {
    requestUrl: string;
    credentialEncryptionKey?: string;
    now?: Date;
  },
): Promise<AgentStorefrontCheckoutSubmitResult> {
  const now = options.now ?? new Date();
  const requestId = checkoutRequestId(contextId, input.idempotencyKey);
  const requestKey = await requestKeyForCheckout(requestId);
  const owned = await loadOwnedContext(db, grantId, contextId);
  const replay = await replayCommittedCheckout(db, contextId, requestKey);
  if (replay) return { response: replay, postCommitPayload: null, availabilityVariantIds: [] };
  assertActiveContext(owned, input.expectedRevision, now);
  if (!owned.cityId || !owned.zoneId || !owned.shippingMethodId) {
    throw new ValidationError("Select a city, zone, and shipping method before checkout.");
  }

  const cart = await resolveContextCartIdentities(db, owned);
  const authority = await loadStorefrontCheckoutAuthority(db, {
    items: cart,
    inventoryPool: InventoryPool.REGULAR,
    city: owned.cityId,
    zone: owned.zoneId,
    area: owned.areaId,
    shippingMethodId: owned.shippingMethodId,
    customerEmail: input.customerEmail,
    customerPhone: input.customerPhone,
  }, options.credentialEncryptionKey);
  if (!authority.cartValidation.valid) {
    throw new ValidationError("Some items in the storefront cart need attention.", {
      itemIssues: authority.cartValidation.issues,
    });
  }

  const customer = await liveContextCustomer(db, owned);
  const checkoutSettings = customer
    ? assertStorefrontCheckoutPolicy(input.customerPhone, input.paymentMethod, authority)
    : assertGuestStorefrontCheckoutPolicy(input.customerPhone, input.paymentMethod, authority);
  if (customer && customer.phone !== input.customerPhone) {
    throw new ValidationError("Checkout phone must match the authorized customer phone.");
  }
  if (input.paymentMethod === PaymentMethod.SSLCOMMERZ && authority.currency.currencyCode !== "BDT") {
    throw new ValidationError("SSLCommerz checkout requires the store currency to be BDT.");
  }

  const data = {
    checkoutRequestId: requestId,
    customerName: input.customerName.trim(),
    customerPhone: input.customerPhone,
    customerEmail: input.customerEmail?.trim().toLowerCase() ?? null,
    shippingAddress: input.shippingAddress.trim(),
    city: owned.cityId,
    zone: owned.zoneId,
    area: owned.areaId,
    cityName: authority.deliveryPreflight.cityName,
    zoneName: authority.deliveryPreflight.zoneName,
    areaName: authority.deliveryPreflight.areaName,
    notes: input.notes?.trim() || null,
    items: authority.cartValidation.items.map((item) => ({
      productId: item.productId,
      variantId: item.variantId,
      quantity: item.quantity,
      price: item.unitPrice,
      productName: item.productName,
      variantLabel: item.variantLabel,
    })),
    discountAmount: 0,
    discountCode: owned.discountCode,
    shippingCharge: authority.deliveryPreflight.shippingCharge,
    shippingMethodId: owned.shippingMethodId,
    paymentMethod: input.paymentMethod,
    inventoryPool: InventoryPool.REGULAR,
  };
  const attemptIdentity = await buildCheckoutAttemptIdentity(data);
  const existing = await resolveExistingCheckoutAttempt<AgentStorefrontCheckoutSubmitView>(db, attemptIdentity);
  if (existing?.status === "replay") {
    return { response: existing.response, postCommitPayload: null, availabilityVariantIds: [] };
  }
  if (existing?.status === "processing") {
    return {
      response: {
        status: "processing",
        contextRevision: owned.revision,
        orderId: existing.orderId,
        message: "Order creation is already processing.",
      },
      postCommitPayload: null,
      availabilityVariantIds: [],
    };
  }
  const attempt = existing?.status === "retry"
    ? existing.attempt
    : createAtomicCheckoutAttempt(attemptIdentity);

  type DiscountCartItem = { id: string; price: number; quantity: number; variantId: string };
  const prepared = await createStorefrontOrder(
    db,
    data,
    options.requestUrl,
    (storeDb, code, total, items, phone) => isDiscountValid(
      storeDb,
      code,
      total,
      items as DiscountCartItem[],
      phone,
    ),
    (storeDb, discount, total, items, shipping, applicableIds, restricted) => calculateDiscountAmount(
      storeDb,
      discount as { id: string; type: string; valueType: string; discountValue: number },
      total,
      items as DiscountCartItem[],
      shipping,
      applicableIds,
      authority.currency.currencyCode,
      restricted,
    ),
    { orderId: attempt.orderId, checkoutToken: attempt.checkoutToken },
    authority.cartValidation,
    authority.deliveryPreflight,
    customer ? { customerId: customer.id, source: "authenticated" } : undefined,
    {
      code: authority.currency.currencyCode,
      decimalPlaces: getDecimalPlaces(authority.currency.currencyCode),
    },
    undefined,
    createTrustedStorefrontCheckoutPolicySnapshot({
      partialPaymentEnabled: checkoutSettings.partialPaymentEnabled,
      authorityRevision: authority.authorityRevision,
      orderCreatedNotificationEnabled: authority.sideEffects.orderCreatedNotification,
      metaPurchaseEnabled: authority.sideEffects.metaPurchase,
    }),
    authority.taxAuthority,
  );

  if (input.paymentMethod === PaymentMethod.SSLCOMMERZ) {
    const configuredDeposit = checkoutSettings.partialPaymentAmount;
    const charge = checkoutSettings.partialPaymentEnabled
      && configuredDeposit > 0
      && configuredDeposit < prepared.totalAmount
      ? configuredDeposit
      : prepared.totalAmount;
    const issue = getSSLCommerzBdtAmountLimitIssue(charge);
    if (issue) throw new ValidationError(issue);
  }

  const response: AgentStorefrontCheckoutSubmitView = {
    status: "complete",
    contextRevision: owned.revision + 1,
    orderId: prepared.orderId,
    orderStatus: prepared.commitPayload.orderData.status,
    paymentMethod: prepared.paymentMethod,
    paymentStatus: prepared.commitPayload.orderData.paymentStatus,
    totalAmount: prepared.totalAmount,
    totalAmountMinor: prepared.taxQuote.totalMinor,
    taxAmount: prepared.taxQuote.taxMinor / (10 ** prepared.taxQuote.decimalPlaces),
    taxAmountMinor: prepared.taxQuote.taxMinor,
    taxLabel: prepared.taxQuote.displayLabel,
    pricesIncludeTax: prepared.taxQuote.pricesIncludeTax,
    currencyCode: prepared.taxQuote.currencyCode,
    decimalPlaces: prepared.taxQuote.decimalPlaces,
    message: input.paymentMethod === PaymentMethod.COD
      ? "Cash-on-delivery order created."
      : "Order created. Start secure payment with storefront.orders.payment.begin.",
  };

  try {
    await commitStorefrontOrderPayload(db, prepared.commitPayload, {
      attempt,
      response,
      agentContext: {
        contextId,
        grantId,
        expectedRevision: owned.revision,
        expiresAt: owned.expiresAt,
      },
    });
  } catch (error) {
    const recovered = await resolveExistingCheckoutAttempt<AgentStorefrontCheckoutSubmitView>(
      db,
      attemptIdentity,
    ).catch(() => null);
    if (recovered?.status === "replay") {
      return { response: recovered.response, postCommitPayload: null, availabilityVariantIds: [] };
    }
    throw error;
  }

  return {
    response,
    postCommitPayload: prepared.commitPayload,
    availabilityVariantIds: [...new Set(prepared.commitPayload.items.map((item) => item.variantId))],
  };
}

export async function createAgentStorefrontContinuation(
  db: Database,
  grantId: string,
  contextId: string,
  input: {
    kind: "customer_auth" | "payment" | "payment_recovery";
    orderId?: string | null;
    now?: Date;
  },
): Promise<{
  id: string;
  kind: typeof input.kind;
  status: "pending";
  expiresAt: string;
  bootstrapCode: string;
}> {
  const now = input.now ?? new Date();
  const context = await loadOwnedContext(db, grantId, contextId);
  if (context.status !== "active" || context.closedAt || context.expiresAt <= now) {
    throw new ConflictError("This storefront context is not active.");
  }
  if (input.kind === "payment" && input.orderId) {
    const grant = await db.select({ orderId: agentStorefrontOrderGrants.orderId })
      .from(agentStorefrontOrderGrants)
      .where(and(
        eq(agentStorefrontOrderGrants.contextId, contextId),
        eq(agentStorefrontOrderGrants.orderId, input.orderId),
        gt(agentStorefrontOrderGrants.expiresAt, now),
      ))
      .get();
    const customer = grant ? null : await liveContextCustomer(db, context);
    const customerOrder = customer ? await db.select({ id: orders.id }).from(orders)
      .where(and(
        eq(orders.id, input.orderId),
        eq(orders.accountOwnerCustomerId, customer.id),
        isNull(orders.deletedAt),
      ))
      .get() : null;
    if (!grant && !customerOrder) throw new UnauthorizedError("This context is not authorized for that order.");
  }
  const expiresAt = paymentContinuationExpiry(now, context.expiresAt);
  // Bootstrap codes are one-time secrets and are never stored in plaintext, so
  // a new begin request must mint a new continuation instead of returning an
  // existing row whose bootstrap code cannot be recovered.
  const id = `acn_${nanoid(20)}`;
  const bootstrap = await createAgentStorefrontBootstrap(id, nanoid(43));
  const row = await db.insert(agentStorefrontContinuations).values({
    id,
    contextId,
    kind: input.kind,
    orderId: input.orderId ?? null,
    status: "pending",
    expiresAt,
    bootstrapCodeHash: bootstrap.codeHash,
    createdAt: now,
    updatedAt: now,
  }).returning({
    id: agentStorefrontContinuations.id,
    kind: agentStorefrontContinuations.kind,
    status: agentStorefrontContinuations.status,
    expiresAt: agentStorefrontContinuations.expiresAt,
  }).get();
  if (!row) throw new ServiceUnavailableError("The secure storefront step could not be started.");
  return {
    id: row.id,
    kind: row.kind,
    status: "pending",
    expiresAt: row.expiresAt.toISOString(),
    bootstrapCode: bootstrap.code,
  };
}
