import {
  buildBatchGuard,
  isBatchGuardError,
  type Database,
} from "@scalius/database/client";
import { checkoutAttempts, orderReceipts, orders } from "@scalius/database/schema";
import { and, eq, getTableColumns, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { generateOrderId } from "@scalius/shared/order-utils";
import { ConflictError, ForbiddenError, ServiceUnavailableError } from "@scalius/core/errors";
import {
  createOrderReceiptToken,
  type CreateStorefrontOrderInput,
  hashOrderReceiptToken,
  ORDER_RECEIPT_TOKEN_TTL_SECONDS,
} from "../orders";
import { sha256Hex } from "@scalius/shared/hash";
import { validateAndFormatPhone } from "@scalius/shared/customer-utils";

export interface CheckoutAttemptIdentity {
  requestKey: string;
  requestHash: string;
  customerWhatsapp: string | null;
  checkoutRequestId: string;
  statusToken: string;
}

/**
 * A checkout identity prepared in memory and committed with the order: the
 * attempt row exists only once its order does (no lease, no processing row),
 * so a request key either replays its committed order or starts a new one.
 */
export interface AtomicCheckoutAttempt {
  id: string;
  requestKey: string;
  requestHash: string;
  orderId: string;
  checkoutToken: string;
  statusToken: string;
}

export type CheckoutAttemptReplayResult<TResponse> = { status: "replay"; response: TResponse };

const CHECKOUT_ATTEMPT_REQUEST_KEY_PREFIX = "checkout_submit:v1:";
const CHECKOUT_STATUS_TOKEN_PREFIX = "cst_";
const CHECKOUT_ATTEMPT_ATOMIC_COMMIT_CONFLICT = "checkout_attempt_atomic_commit_conflict";

export type CheckoutAttemptRow = typeof checkoutAttempts.$inferSelect & {
  linkedOrderId: string | null;
  linkedOrderStatus: string | null;
  linkedOrderDeletedAt: number | null;
  linkedOrderPaymentStatus: string | null;
  linkedOrderPaidAmountMinor: number | null;
  linkedOrderPaymentMethod: string | null;
  linkedOrderAccountOwnerCustomerId: string | null;
};

/** A missing order is not proof that another order can safely be placed. */
export function isEndedCheckoutOrder(order: {
  id: string | null;
  status: string | null;
  deletedAt: Date | number | null;
  paymentStatus: string | null;
  paidAmountMinor: number | null;
}): boolean {
  return order.id !== null
    && order.status === "cancelled"
    && order.deletedAt !== null
    && order.paidAmountMinor === 0
    && (order.paymentStatus === "unpaid" || order.paymentStatus === "failed" || order.paymentStatus === "refunded");
}

class CheckoutAttemptError extends ConflictError {
  constructor(
    public override readonly code: "checkout_attempt_expired" | "checkout_attempt_conflict",
    message: string,
    public override readonly details?: { orderId: string; paymentMethod: string | null },
  ) {
    super(message);
  }
}
type SQLiteBatchItem = BatchItem<"sqlite">;

export interface PreparedAtomicCheckoutAttemptCommit {
  writesBeforeOrder: SQLiteBatchItem[];
  writesAfterOrder: SQLiteBatchItem[];
}

export async function buildCheckoutAttemptIdentity(
  input: CreateStorefrontOrderInput,
): Promise<CheckoutAttemptIdentity> {
  const checkoutRequestId = normalizeCheckoutRequestId(input.checkoutRequestId);
  const requestKeyHash = await sha256Hex(checkoutRequestId);
  const normalized = normalizeCheckoutRequest(input);
  const customerWhatsapp = normalizeCheckoutWhatsapp(input);
  // A separate number binds the submitted contact even if settings discard it.
  const requestHash = await sha256Hex(stableStringify({ ...normalized, customerWhatsapp }));
  const requestKey = `${CHECKOUT_ATTEMPT_REQUEST_KEY_PREFIX}${requestKeyHash}`;

  return {
    requestKey,
    requestHash,
    customerWhatsapp,
    checkoutRequestId,
    statusToken: buildCheckoutStatusTokenFromRequestKey(requestKey),
  };
}

export function buildCheckoutStatusTokenFromRequestKey(requestKey: string): string {
  if (!requestKey.startsWith(CHECKOUT_ATTEMPT_REQUEST_KEY_PREFIX)) {
    throw new Error("Unsupported checkout attempt request key.");
  }

  return `${CHECKOUT_STATUS_TOKEN_PREFIX}${requestKey.slice(CHECKOUT_ATTEMPT_REQUEST_KEY_PREFIX.length)}`;
}

export function getCheckoutAttemptRequestKeyFromStatusToken(statusToken: string): string | null {
  if (!statusToken.startsWith(CHECKOUT_STATUS_TOKEN_PREFIX)) return null;

  const requestKeyHash = statusToken.slice(CHECKOUT_STATUS_TOKEN_PREFIX.length);
  if (!/^[a-f0-9]{64}$/.test(requestKeyHash)) return null;

  return `${CHECKOUT_ATTEMPT_REQUEST_KEY_PREFIX}${requestKeyHash}`;
}

export function createAtomicCheckoutAttempt(
  identity: CheckoutAttemptIdentity,
): AtomicCheckoutAttempt {
  return {
    id: createCheckoutAttemptId(),
    requestKey: identity.requestKey,
    requestHash: identity.requestHash,
    orderId: generateOrderId(),
    checkoutToken: createCheckoutToken(),
    statusToken: identity.statusToken,
  };
}

export async function resolveExistingCheckoutAttempt<TResponse>(
  db: Database,
  identity: CheckoutAttemptIdentity,
  customerId?: string | null | PromiseLike<string | null>,
): Promise<CheckoutAttemptReplayResult<TResponse> | null> {
  const existing = await selectCheckoutAttemptByKey(db, identity.requestKey).get();
  return resolveCheckoutAttemptRow<TResponse>(
    existing,
    identity,
    existing?.linkedOrderAccountOwnerCustomerId ? await customerId : undefined,
  );
}

/** Replay or 409 decision for a row read by `selectCheckoutAttemptByKey`; null starts a new attempt. */
export function resolveCheckoutAttemptRow<TResponse>(
  existing: CheckoutAttemptRow | undefined,
  identity: CheckoutAttemptIdentity,
  customerId?: string | null,
): CheckoutAttemptReplayResult<TResponse> | null {
  if (existing?.linkedOrderAccountOwnerCustomerId && existing.linkedOrderAccountOwnerCustomerId !== customerId) {
    throw new ForbiddenError("Sign in to the account that started this checkout to continue.");
  }
  if (existing && isEndedCheckoutOrder({
    id: existing.linkedOrderId,
    status: existing.linkedOrderStatus,
    deletedAt: existing.linkedOrderDeletedAt,
    paymentStatus: existing.linkedOrderPaymentStatus,
    paidAmountMinor: existing.linkedOrderPaidAmountMinor,
  })) {
    throw new CheckoutAttemptError(
      "checkout_attempt_expired",
      "This checkout has ended. Return to your cart to review it and start a new checkout.",
    );
  }
  assertSameCheckoutRequest(existing, identity);
  return replayCheckoutAttempt<TResponse>(existing);
}

/**
 * Prepare a committed idempotency row and receipt around the authoritative
 * order transaction. The insert is intentionally first: duplicate submissions
 * arbitrate before inventory and order writes (the loser inserts nothing and
 * its guard fails). A named marker keeps this guard distinguishable from
 * stock and promotion guards after rollback.
 */
export async function prepareAtomicCheckoutAttemptCommit<TResponse>(
  db: Database,
  attempt: AtomicCheckoutAttempt,
  options: {
    paymentMethod: string;
    totalAmountMinor: number;
    response: TResponse;
  },
): Promise<PreparedAtomicCheckoutAttemptCommit> {
  const responsePayload = JSON.stringify(options.response);
  const tokenHash = await hashOrderReceiptToken(attempt.checkoutToken);

  const attemptWrite = db
    .insert(checkoutAttempts)
    .values({
      id: attempt.id,
      requestKey: attempt.requestKey,
      requestHash: attempt.requestHash,
      checkoutToken: attempt.checkoutToken,
      orderId: attempt.orderId,
      status: "committed",
      paymentMethod: options.paymentMethod,
      totalAmountMinor: options.totalAmountMinor,
      responsePayload,
      attempts: 1,
      createdAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    })
    .onConflictDoNothing({ target: checkoutAttempts.requestKey });

  const committedIdentityCondition = and(
    eq(checkoutAttempts.id, attempt.id),
    eq(checkoutAttempts.requestKey, attempt.requestKey),
    eq(checkoutAttempts.requestHash, attempt.requestHash),
    eq(checkoutAttempts.orderId, attempt.orderId),
    eq(checkoutAttempts.checkoutToken, attempt.checkoutToken),
    eq(checkoutAttempts.status, "committed"),
    eq(checkoutAttempts.responsePayload, responsePayload),
  );
  const guard = buildBatchGuard(db, sql`EXISTS (
    SELECT 1
    FROM ${checkoutAttempts}
    WHERE ${committedIdentityCondition}
  )`, CHECKOUT_ATTEMPT_ATOMIC_COMMIT_CONFLICT);

  const receiptWrite = db
    .insert(orderReceipts)
    .values({
      tokenHash,
      orderId: attempt.orderId,
      source: "checkout_attempt",
      status: "active",
      expiresAt: sql`unixepoch() + ${ORDER_RECEIPT_TOKEN_TTL_SECONDS}`,
      createdAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    })
    .onConflictDoUpdate({
      target: orderReceipts.tokenHash,
      set: {
        orderId: attempt.orderId,
        source: "checkout_attempt",
        status: "active",
        expiresAt: sql`unixepoch() + ${ORDER_RECEIPT_TOKEN_TTL_SECONDS}`,
        updatedAt: sql`unixepoch()`,
      },
    });

  return {
    writesBeforeOrder: [attemptWrite, guard] as SQLiteBatchItem[],
    writesAfterOrder: [receiptWrite] as SQLiteBatchItem[],
  };
}

export function isCheckoutAttemptCommitConflictError(error: unknown): boolean {
  return isBatchGuardError(error, CHECKOUT_ATTEMPT_ATOMIC_COMMIT_CONFLICT);
}

/** The idempotency row for a request key; composable into a read batch. */
export function selectCheckoutAttemptByKey(db: Database, requestKey: string) {
  return db
    .select({
      ...getTableColumns(checkoutAttempts),
      linkedOrderId: sql<string | null>`${orders.id}`.as("linked_order_id"),
      linkedOrderStatus: sql<string | null>`${orders.status}`.as("linked_order_status"),
      linkedOrderDeletedAt: sql<number | null>`${orders.deletedAt}`.as("linked_order_deleted_at"),
      linkedOrderPaymentStatus: sql<string | null>`${orders.paymentStatus}`.as("linked_order_payment_status"),
      linkedOrderPaidAmountMinor: sql<number | null>`${orders.paidAmountMinor}`.as("linked_order_paid_amount_minor"),
      linkedOrderPaymentMethod: sql<string | null>`${orders.paymentMethod}`.as("linked_order_payment_method"),
      linkedOrderAccountOwnerCustomerId: sql<string | null>`${orders.accountOwnerCustomerId}`.as("linked_order_account_owner_customer_id"),
    })
    .from(checkoutAttempts)
    .leftJoin(orders, eq(orders.id, checkoutAttempts.orderId))
    .where(eq(checkoutAttempts.requestKey, requestKey));
}

function replayCheckoutAttempt<TResponse>(
  row: CheckoutAttemptRow | undefined,
): CheckoutAttemptReplayResult<TResponse> | null {
  if (!row || row.status !== "committed") return null;
  if (!row.linkedOrderId) {
    throw new ServiceUnavailableError("Checkout order is unavailable. Please try again.");
  }
  if (!row.responsePayload) {
    throw new ServiceUnavailableError("Checkout replay payload is unavailable. Please try again.");
  }

  try {
    return {
      status: "replay",
      response: JSON.parse(row.responsePayload) as TResponse,
    };
  } catch {
    throw new ServiceUnavailableError("Checkout replay payload is unreadable. Please try again.");
  }
}

function assertSameCheckoutRequest(
  row: CheckoutAttemptRow | undefined,
  identity: CheckoutAttemptIdentity,
): void {
  if (!row) return;
  if (row.requestHash !== identity.requestHash) {
    throw new CheckoutAttemptError(
      "checkout_attempt_conflict",
      "An earlier checkout already uses this request. Review that checkout before placing another order.",
      row.linkedOrderId ? { orderId: row.linkedOrderId, paymentMethod: row.linkedOrderPaymentMethod } : undefined,
    );
  }
}

function createCheckoutAttemptId(): string {
  return `coa_${crypto.randomUUID()}`;
}

function createCheckoutToken(): string {
  return createOrderReceiptToken();
}

function normalizeCheckoutRequestId(value: string): string {
  return value.trim();
}

function normalizeCheckoutWhatsapp(input: CreateStorefrontOrderInput): string | null {
  const raw = input.customerWhatsapp?.trim();
  if (!raw) return null;
  let number = raw;
  try {
    number = validateAndFormatPhone(raw);
  } catch {
    // Contact policy owns validation; hidden fields may be ignored there.
  }
  return number === input.customerPhone?.trim() ? null : number;
}

function normalizeCheckoutRequest(input: CreateStorefrontOrderInput): Record<string, unknown> {
  return {
    // 4: the country-aware shipping address (MARKETS-DESIGN step 3a).
    version: 4,
    expectedQuoteFingerprint: input.expectedQuoteFingerprint,
    customerName: input.customerName.trim(),
    customerPhone: input.customerPhone?.trim() || null,
    customerEmail: input.customerEmail?.trim().toLowerCase() ?? null,
    shippingCountryCode: input.shippingCountryCode?.trim().toUpperCase() || null,
    shippingAddress: input.shippingAddress?.trim() || null,
    shippingAddressLine2: input.shippingAddressLine2?.trim() || null,
    shippingDependentLocality: input.shippingDependentLocality?.trim() || null,
    shippingLocality: input.shippingLocality?.trim() || null,
    shippingAdminArea: input.shippingAdminArea?.trim() || null,
    shippingPostalCode: input.shippingPostalCode?.trim() || null,
    city: input.city ?? null,
    zone: input.zone ?? null,
    area: input.area ?? null,
    notes: input.notes ?? null,
    ...(Object.keys(input.attributes ?? {}).length ? { attributes: Object.entries(input.attributes!).sort(([a], [b]) => a.localeCompare(b)) } : {}),
    items: input.items.map((item) => ({
      productId: item.productId,
      variantId: item.variantId,
      quantity: item.quantity,
      price: item.price === undefined ? null : normalizeAmount(item.price),
      productName: item.productName ?? null,
      variantLabel: item.variantLabel ?? null,
      // Absent for carts without buyer inputs, so pre-Wave A hashes are unchanged.
      ...(item.properties && item.properties.length > 0
        ? { properties: item.properties.map((property) => [property.key, property.value]) }
        : {}),
      // Absent for one-time lines, so hashes of carts without purchase options are unchanged.
      ...(item.purchaseOption ? { purchaseOption: item.purchaseOption } : {}),
    })),
    discountCodes: [...new Set(input.discountCodes.map((code) => code.trim().toUpperCase()))].sort(),
    shippingCharge: normalizeAmount(input.shippingCharge),
    shippingMethodId: input.shippingMethodId ?? null,
    paymentMethod: input.paymentMethod,
    inventoryPool: input.inventoryPool,
    // Only with a billing address (0119), so hashes of requests without one are unchanged.
    ...(input.billingSameAsShipping === false ? { billingSameAsShipping: false } : {}),
    ...(input.billingCountryCode?.trim()
      ? {
        billing: [
          input.billingCountryCode, input.billingName, input.billingCompany, input.billingAddress,
          input.billingAddressLine2, input.billingDependentLocality, input.billingLocality,
          input.billingAdminArea, input.billingPostalCode,
        ].map((value) => value?.trim() || null),
      }
      : {}),
    // Only with gift cards, so hashes of requests without them are unchanged.
    // Handles keep the buyer's order: it decides which card is debited first,
    // so the same cards in another order are a different request.
    ...(input.giftCards && input.giftCards.length > 0
      ? {
        giftCards: input.giftCards.map((card) => card.handle.trim()),
        expectedAmountDueMinor: input.expectedAmountDueMinor ?? null,
      }
      : {}),
  };
}

function normalizeAmount(amount: number): number {
  return Math.round(amount * 1_000_000) / 1_000_000;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}
