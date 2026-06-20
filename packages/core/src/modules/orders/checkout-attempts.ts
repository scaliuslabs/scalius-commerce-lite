import type { Database } from "@scalius/database/client";
import { checkoutAttempts } from "@scalius/database/schema";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { generateOrderId } from "@scalius/shared/order-utils";
import { ConflictError, ServiceUnavailableError } from "@scalius/core/errors";
import type { CreateStorefrontOrderInput } from "./orders.types";

export interface CheckoutAttemptIdentity {
  requestKey: string;
  requestHash: string;
  checkoutRequestId: string;
}

export interface ClaimedCheckoutAttempt {
  id: string;
  requestKey: string;
  requestHash: string;
  claimId: string;
  orderId: string;
  checkoutToken: string;
}

export type CheckoutAttemptClaimResult<TResponse> =
  | { status: "claimed"; attempt: ClaimedCheckoutAttempt }
  | CheckoutAttemptReplayResult<TResponse>
  | CheckoutAttemptProcessingResult;

export type CheckoutAttemptReplayResult<TResponse> = { status: "replay"; response: TResponse };
export type CheckoutAttemptProcessingResult = { status: "processing"; orderId: string; checkoutToken: string };
export type ExistingCheckoutAttemptResult<TResponse> =
  | CheckoutAttemptReplayResult<TResponse>
  | CheckoutAttemptProcessingResult;

const CHECKOUT_ATTEMPT_LEASE_SECONDS = 5 * 60;
const MAX_ERROR_LENGTH = 500;

type CheckoutAttemptRow = typeof checkoutAttempts.$inferSelect;

export async function buildCheckoutAttemptIdentity(
  input: CreateStorefrontOrderInput,
): Promise<CheckoutAttemptIdentity> {
  const checkoutRequestId = normalizeCheckoutRequestId(input.checkoutRequestId);
  const requestKeyHash = await sha256Hex(checkoutRequestId);
  const requestHash = await sha256Hex(stableStringify(normalizeCheckoutRequest(input)));

  return {
    requestKey: `checkout_submit:v1:${requestKeyHash}`,
    requestHash,
    checkoutRequestId,
  };
}

export async function claimCheckoutAttempt<TResponse>(
  db: Database,
  identity: CheckoutAttemptIdentity,
): Promise<CheckoutAttemptClaimResult<TResponse>> {
  const claimId = createCheckoutAttemptClaimId();
  const generatedOrderId = generateOrderId();
  const generatedCheckoutToken = createCheckoutToken();

  const inserted = await db
    .insert(checkoutAttempts)
    .values({
      id: createCheckoutAttemptId(),
      requestKey: identity.requestKey,
      requestHash: identity.requestHash,
      checkoutToken: generatedCheckoutToken,
      orderId: generatedOrderId,
      status: "processing",
      attempts: 1,
      claimId,
      claimExpiresAt: sql`unixepoch() + ${CHECKOUT_ATTEMPT_LEASE_SECONDS}`,
      lastError: null,
      createdAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    })
    .onConflictDoNothing()
    .returning({
      id: checkoutAttempts.id,
      requestKey: checkoutAttempts.requestKey,
      requestHash: checkoutAttempts.requestHash,
      orderId: checkoutAttempts.orderId,
      checkoutToken: checkoutAttempts.checkoutToken,
    });

  if (inserted[0]?.id) {
    return {
      status: "claimed",
      attempt: {
        id: inserted[0].id,
        requestKey: inserted[0].requestKey,
        requestHash: inserted[0].requestHash,
        claimId,
        orderId: inserted[0].orderId,
        checkoutToken: inserted[0].checkoutToken,
      },
    };
  }

  const existing = await selectCheckoutAttemptByKey(db, identity.requestKey);
  assertSameCheckoutRequest(existing, identity);

  const replay = replayCheckoutAttempt<TResponse>(existing);
  if (replay) return replay;

  const reclaimed = await db
    .update(checkoutAttempts)
    .set({
      status: "processing",
      claimId,
      claimExpiresAt: sql`unixepoch() + ${CHECKOUT_ATTEMPT_LEASE_SECONDS}`,
      attempts: sql`${checkoutAttempts.attempts} + 1`,
      lastError: null,
      updatedAt: sql`unixepoch()`,
    })
    .where(
      and(
        eq(checkoutAttempts.requestKey, identity.requestKey),
        eq(checkoutAttempts.requestHash, identity.requestHash),
        or(
          eq(checkoutAttempts.status, "failed"),
          and(
            eq(checkoutAttempts.status, "processing"),
            or(
              isNull(checkoutAttempts.claimExpiresAt),
              lte(checkoutAttempts.claimExpiresAt, sql`unixepoch()`),
            ),
          ),
        ),
      ),
    )
    .returning({
      id: checkoutAttempts.id,
      requestKey: checkoutAttempts.requestKey,
      requestHash: checkoutAttempts.requestHash,
      orderId: checkoutAttempts.orderId,
      checkoutToken: checkoutAttempts.checkoutToken,
    });

  if (reclaimed[0]?.id) {
    return {
      status: "claimed",
      attempt: {
        id: reclaimed[0].id,
        requestKey: reclaimed[0].requestKey,
        requestHash: reclaimed[0].requestHash,
        claimId,
        orderId: reclaimed[0].orderId,
        checkoutToken: reclaimed[0].checkoutToken,
      },
    };
  }

  const latest = await selectCheckoutAttemptByKey(db, identity.requestKey);
  assertSameCheckoutRequest(latest, identity);
  const latestReplay = replayCheckoutAttempt<TResponse>(latest);
  if (latestReplay) return latestReplay;

  if (!latest) {
    throw new ServiceUnavailableError("Checkout attempt state is unavailable. Please try again.");
  }

  return {
    status: "processing",
    orderId: latest.orderId,
    checkoutToken: latest.checkoutToken,
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

  if (!existing || existing.status !== "processing") return null;
  if (existing.claimExpiresAt == null || existing.claimExpiresAt <= nowSeconds) return null;

  return {
    status: "processing",
    orderId: existing.orderId,
    checkoutToken: existing.checkoutToken,
  };
}

export async function markCheckoutAttemptCommitted<TResponse>(
  db: Database,
  attempt: ClaimedCheckoutAttempt,
  options: {
    paymentMethod: string;
    totalAmount: number;
    response: TResponse;
  },
): Promise<void> {
  const rows = await db
    .update(checkoutAttempts)
    .set({
      status: "committed",
      paymentMethod: options.paymentMethod,
      totalAmount: options.totalAmount,
      responsePayload: JSON.stringify(options.response),
      claimId: null,
      claimExpiresAt: null,
      lastError: null,
      updatedAt: sql`unixepoch()`,
    })
    .where(
      and(
        eq(checkoutAttempts.id, attempt.id),
        eq(checkoutAttempts.claimId, attempt.claimId),
      ),
    )
    .returning({ id: checkoutAttempts.id });

  if (rows.length === 0) {
    throw new ConflictError("Checkout attempt claim was lost before the committed order response was stored.");
  }
}

export async function markCheckoutAttemptFailed(
  db: Database,
  attempt: ClaimedCheckoutAttempt,
  error: unknown,
): Promise<void> {
  await db
    .update(checkoutAttempts)
    .set({
      status: "failed",
      claimId: null,
      claimExpiresAt: null,
      lastError: serializeAttemptError(error),
      updatedAt: sql`unixepoch()`,
    })
    .where(
      and(
        eq(checkoutAttempts.id, attempt.id),
        eq(checkoutAttempts.claimId, attempt.claimId),
      ),
    );
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

function createCheckoutAttemptClaimId(): string {
  return `coac_${crypto.randomUUID()}`;
}

function createCheckoutToken(): string {
  return `chk_${nanoid()}`;
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
      variantId: item.variantId ?? null,
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

function serializeAttemptError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_LENGTH);
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
