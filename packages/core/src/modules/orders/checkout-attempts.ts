import { buildBatchGuard, type Database } from "@scalius/database/client";
import { checkoutAttempts, orderReceipts, orders } from "@scalius/database/schema";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { generateOrderId } from "@scalius/shared/order-utils";
import { ConflictError, ServiceUnavailableError } from "@scalius/core/errors";
import type { CreateStorefrontOrderInput } from "./orders.types";
import {
  createOrderReceiptToken,
  hashOrderReceiptToken,
  ORDER_RECEIPT_TOKEN_TTL_SECONDS,
} from "./order-receipts";

export interface CheckoutAttemptIdentity {
  requestKey: string;
  requestHash: string;
  checkoutRequestId: string;
  statusToken: string;
}

/**
 * A checkout identity prepared in memory and committed with the order. New
 * storefront submits use this instead of creating a durable processing lease
 * before validation and order construction finish.
 */
export interface AtomicCheckoutAttempt {
  commitMode: "atomic";
  origin: "new" | "retry";
  id: string;
  requestKey: string;
  requestHash: string;
  orderId: string;
  checkoutToken: string;
  statusToken: string;
}

export type CheckoutAttemptReplayResult<TResponse> = { status: "replay"; response: TResponse };
export type CheckoutAttemptProcessingResult = { status: "processing"; orderId: string; statusToken: string };
export type ExistingCheckoutAttemptResult<TResponse> =
  | CheckoutAttemptReplayResult<TResponse>
  | CheckoutAttemptProcessingResult
  | { status: "retry"; attempt: AtomicCheckoutAttempt };

const CHECKOUT_ATTEMPT_REQUEST_KEY_PREFIX = "checkout_submit:v1:";
const CHECKOUT_STATUS_TOKEN_PREFIX = "cst_";
const CHECKOUT_ATTEMPT_ATOMIC_COMMIT_CONFLICT = "CHECKOUT_ATTEMPT_ATOMIC_COMMIT_CONFLICT";

type CheckoutAttemptRow = typeof checkoutAttempts.$inferSelect;
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
  const requestHash = await sha256Hex(stableStringify(normalizeCheckoutRequest(input)));
  const requestKey = `${CHECKOUT_ATTEMPT_REQUEST_KEY_PREFIX}${requestKeyHash}`;

  return {
    requestKey,
    requestHash,
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
    commitMode: "atomic",
    origin: "new",
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
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<ExistingCheckoutAttemptResult<TResponse> | null> {
  const existing = await selectCheckoutAttemptByKey(db, identity.requestKey);
  assertSameCheckoutRequest(existing, identity);

  const replay = replayCheckoutAttempt<TResponse>(existing);
  if (replay) return replay;

  if (!existing) {
    const aggregate = await db
      .select({
        requestHash: orders.checkoutRequestHash,
        responsePayload: orders.checkoutResponsePayload,
      })
      .from(orders)
      .where(eq(orders.checkoutRequestKey, identity.requestKey))
      .get();
    if (!aggregate) return null;
    if (aggregate.requestHash !== identity.requestHash) {
      throw new ConflictError("This checkout request was already used for different checkout details. Please refresh checkout and try again.");
    }
    if (!aggregate.responsePayload) {
      throw new ServiceUnavailableError("Checkout replay payload is unavailable. Please try again.");
    }
    try {
      return {
        status: "replay",
        response: JSON.parse(aggregate.responsePayload) as TResponse,
      };
    } catch {
      throw new ServiceUnavailableError("Checkout replay payload is unreadable. Please try again.");
    }
  }
  if (isRetryableCheckoutAttempt(existing, nowSeconds)) {
    return {
      status: "retry",
      attempt: atomicCheckoutAttemptFromRow(existing),
    };
  }
  if (existing.status !== "processing") return null;

  return processingResultFromAttempt(existing);
}

/**
 * Prepare a committed idempotency row and receipt around the authoritative
 * order transaction. The upsert is intentionally first: duplicate submissions
 * arbitrate before inventory and order writes. A named invalid JSON path keeps
 * this guard distinguishable from stock and promotion guards after rollback.
 */
export async function prepareAtomicCheckoutAttemptCommit<TResponse>(
  db: Database,
  attempt: AtomicCheckoutAttempt,
  options: {
    paymentMethod: string;
    totalAmount: number;
    response: TResponse;
  },
): Promise<PreparedAtomicCheckoutAttemptCommit> {
  const responsePayload = JSON.stringify(options.response);
  const tokenHash = await hashOrderReceiptToken(attempt.checkoutToken);
  const retryableExistingAttempt = or(
    eq(checkoutAttempts.status, "failed"),
    and(
      eq(checkoutAttempts.status, "processing"),
      or(
        isNull(checkoutAttempts.claimExpiresAt),
        lte(checkoutAttempts.claimExpiresAt, sql`unixepoch()`),
      ),
    ),
  );

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
      totalAmount: options.totalAmount,
      responsePayload,
      attempts: 1,
      claimId: null,
      claimExpiresAt: null,
      lastError: null,
      createdAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    })
    .onConflictDoUpdate({
      target: checkoutAttempts.requestKey,
      set: {
        status: "committed",
        paymentMethod: options.paymentMethod,
        totalAmount: options.totalAmount,
        responsePayload,
        attempts: sql`${checkoutAttempts.attempts} + 1`,
        claimId: null,
        claimExpiresAt: null,
        lastError: null,
        updatedAt: sql`unixepoch()`,
      },
      setWhere: and(
        eq(checkoutAttempts.requestHash, attempt.requestHash),
        retryableExistingAttempt,
      ),
    });

  const committedIdentityCondition = and(
    eq(checkoutAttempts.id, attempt.id),
    eq(checkoutAttempts.requestKey, attempt.requestKey),
    eq(checkoutAttempts.requestHash, attempt.requestHash),
    eq(checkoutAttempts.orderId, attempt.orderId),
    eq(checkoutAttempts.checkoutToken, attempt.checkoutToken),
    eq(checkoutAttempts.status, "committed"),
    eq(checkoutAttempts.responsePayload, responsePayload),
  );
  const guard = buildBatchGuard(db, sql`CASE WHEN EXISTS (
    SELECT 1
    FROM ${checkoutAttempts}
    WHERE ${committedIdentityCondition}
  ) THEN 1 ELSE json_extract('{}', ${CHECKOUT_ATTEMPT_ATOMIC_COMMIT_CONFLICT}) END`);

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
  let current = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const message = current instanceof Error ? current.message : String(current);
    const normalizedMessage = message.toUpperCase();
    if (normalizedMessage.includes(CHECKOUT_ATTEMPT_ATOMIC_COMMIT_CONFLICT)) return true;
    current = current instanceof Error
      ? (current as Error & { cause?: unknown }).cause
      : null;
  }
  return false;
}

async function selectCheckoutAttemptByKey(
  db: Database,
  requestKey: string,
): Promise<CheckoutAttemptRow | undefined> {
  return db
    .select()
    .from(checkoutAttempts)
    .where(eq(checkoutAttempts.requestKey, requestKey))
    .get();
}

function replayCheckoutAttempt<TResponse>(
  row: CheckoutAttemptRow | undefined,
): CheckoutAttemptReplayResult<TResponse> | null {
  if (!row || row.status !== "committed") return null;
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

function isRetryableCheckoutAttempt(
  row: CheckoutAttemptRow,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  return row.status === "failed" || (
    row.status === "processing"
    && (row.claimExpiresAt === null || row.claimExpiresAt <= nowSeconds)
  );
}

function atomicCheckoutAttemptFromRow(row: CheckoutAttemptRow): AtomicCheckoutAttempt {
  return {
    commitMode: "atomic",
    origin: "retry",
    id: row.id,
    requestKey: row.requestKey,
    requestHash: row.requestHash,
    orderId: row.orderId,
    checkoutToken: row.checkoutToken,
    statusToken: buildCheckoutStatusTokenFromRequestKey(row.requestKey),
  };
}

function processingResultFromAttempt(row: Pick<CheckoutAttemptRow, "orderId" | "requestKey">): CheckoutAttemptProcessingResult {
  return {
    status: "processing",
    orderId: row.orderId,
    statusToken: buildCheckoutStatusTokenFromRequestKey(row.requestKey),
  };
}

function assertSameCheckoutRequest(
  row: CheckoutAttemptRow | undefined,
  identity: CheckoutAttemptIdentity,
): void {
  if (!row) return;
  if (row.requestHash !== identity.requestHash) {
    throw new ConflictError("This checkout request was already used for different checkout details. Please refresh checkout and try again.");
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

function normalizeCheckoutRequest(input: CreateStorefrontOrderInput): Record<string, unknown> {
  return {
    version: 1,
    customerName: input.customerName.trim(),
    customerPhone: input.customerPhone.trim(),
    customerEmail: input.customerEmail?.trim().toLowerCase() ?? null,
    shippingAddress: input.shippingAddress.trim(),
    city: input.city,
    zone: input.zone,
    area: input.area ?? null,
    cityName: input.cityName ?? null,
    zoneName: input.zoneName ?? null,
    areaName: input.areaName ?? null,
    notes: input.notes ?? null,
    items: input.items.map((item) => ({
      productId: item.productId,
      variantId: item.variantId,
      quantity: item.quantity,
      price: normalizeAmount(item.price),
      productName: item.productName ?? null,
      variantLabel: item.variantLabel ?? null,
    })),
    discountAmount: input.discountAmount == null ? null : normalizeAmount(input.discountAmount),
    discountCode: input.discountCode?.trim().toUpperCase() ?? null,
    shippingCharge: normalizeAmount(input.shippingCharge),
    shippingMethodId: input.shippingMethodId ?? null,
    paymentMethod: input.paymentMethod,
    inventoryPool: input.inventoryPool,
  };
}

function normalizeAmount(amount: number): number {
  return Math.round(amount * 1_000_000) / 1_000_000;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
