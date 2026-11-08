import { ONLINE_STORE_CHANNEL_ID } from "@scalius/shared/sales-channels";
import type { Database } from "@scalius/database/client";
import { buildBatchGuard, isBatchGuardError } from "@scalius/database/client";
import { adminOrderCreateAttempts } from "@scalius/database/schema";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { AppError, ServiceUnavailableError, UnauthorizedError } from "@scalius/core/errors";
import { generateOrderId } from "@scalius/shared/order-utils";
import { normalizeOrderChannelSource } from "@scalius/shared/order-channel-source";
import type { CreateOrderInput } from "../validation";
import { sha256Hex } from "@scalius/shared/hash";

export interface AdminOrderCreateAttemptIdentity {
  actorId: string | null;
  requestKeyHash: string;
  requestHash: string;
}

export interface ClaimedAdminOrderCreateAttempt {
  id: string;
  actorId: string | null;
  requestKeyHash: string;
  requestHash: string;
  orderId: string;
  claimId: string;
}

export type AdminOrderCreateAttemptResult<TResponse> =
  | { status: "claimed"; attempt: ClaimedAdminOrderCreateAttempt }
  | { status: "replay"; response: TResponse }
  | { status: "processing"; orderId: string };

const ADMIN_CREATE_ATTEMPT_LEASE_SECONDS = 5 * 60;
const MAX_ATTEMPT_ERROR_LENGTH = 500;
const ADMIN_CREATE_ATTEMPT_GUARD_MARKER = "admin_order_create_attempt_conflict";
export const ADMIN_ORDER_CREATE_REQUEST_MISMATCH = "admin_order_create_request_mismatch";

export type AdminOrderCreateRequestMismatchDetails =
  | {
      state: "failed";
      canRetryWithNewKey: true;
    }
  | {
      state: "processing";
      canRetryWithNewKey: false;
    }
  | {
      state: "committed";
      canRetryWithNewKey: false;
      orderId: string;
    };

type AdminOrderCreateAttemptRow = typeof adminOrderCreateAttempts.$inferSelect;

/**
 * Who a manual-order attempt or amendment key belongs to: `app:<id>` for an
 * app, the staff member's id otherwise. Never a shared fallback: keys scoped
 * by one constant would let one caller replay another's order.
 */
export function requireAttemptPrincipal(principal: string | null | undefined): string {
  const scope = principal?.trim();
  if (!scope) throw new UnauthorizedError("Sign in again to place or change an order.");
  return scope;
}

/**
 * The attempt's identity. Its key is scoped by the principal that places the
 * order (`requireAttemptPrincipal`): two callers' keys never share an attempt.
 */
export async function buildAdminOrderCreateAttemptIdentity(
  input: CreateOrderInput,
  principal: string,
): Promise<AdminOrderCreateAttemptIdentity> {
  const requestKey = input.requestKey.trim();
  const actorId = requireAttemptPrincipal(principal);
  return {
    actorId,
    requestKeyHash: await sha256Hex(`${actorId}:${requestKey}`),
    requestHash: await sha256Hex(stableStringify(normalizeAdminOrderCreateRequest(input))),
  };
}

export async function claimAdminOrderCreateAttempt<TResponse>(
  db: Database,
  identity: AdminOrderCreateAttemptIdentity,
): Promise<AdminOrderCreateAttemptResult<TResponse>> {
  const claimId = `aocac_${crypto.randomUUID()}`;
  const orderId = generateOrderId();
  const inserted = await db
    .insert(adminOrderCreateAttempts)
    .values({
      id: `aoca_${crypto.randomUUID()}`,
      actorId: identity.actorId,
      requestKeyHash: identity.requestKeyHash,
      requestHash: identity.requestHash,
      orderId,
      status: "processing",
      responsePayload: null,
      attempts: 1,
      claimId,
      claimExpiresAt: sql`unixepoch() + ${ADMIN_CREATE_ATTEMPT_LEASE_SECONDS}`,
      lastError: null,
      createdAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    })
    .onConflictDoNothing()
    .returning({
      id: adminOrderCreateAttempts.id,
      actorId: adminOrderCreateAttempts.actorId,
      requestKeyHash: adminOrderCreateAttempts.requestKeyHash,
      requestHash: adminOrderCreateAttempts.requestHash,
      orderId: adminOrderCreateAttempts.orderId,
    });

  if (inserted[0]?.id) {
    return {
      status: "claimed",
      attempt: {
        ...inserted[0],
        claimId,
      },
    };
  }

  const existing = await selectAttemptByKey(db, identity.requestKeyHash);
  await assertSameRequest(db, existing, identity);
  const replay = replayAttempt<TResponse>(existing);
  if (replay) return replay;
  if (existing && isFreshProcessingAttempt(existing)) {
    return { status: "processing", orderId: existing.orderId };
  }

  const reclaimed = await db
    .update(adminOrderCreateAttempts)
    .set({
      status: "processing",
      claimId,
      claimExpiresAt: sql`unixepoch() + ${ADMIN_CREATE_ATTEMPT_LEASE_SECONDS}`,
      attempts: sql`${adminOrderCreateAttempts.attempts} + 1`,
      lastError: null,
      updatedAt: sql`unixepoch()`,
    })
    .where(
      and(
        eq(adminOrderCreateAttempts.requestKeyHash, identity.requestKeyHash),
        eq(adminOrderCreateAttempts.requestHash, identity.requestHash),
        or(
          eq(adminOrderCreateAttempts.status, "failed"),
          and(
            eq(adminOrderCreateAttempts.status, "processing"),
            or(
              isNull(adminOrderCreateAttempts.claimExpiresAt),
              lte(adminOrderCreateAttempts.claimExpiresAt, sql`unixepoch()`),
            ),
          ),
        ),
      ),
    )
    .returning({
      id: adminOrderCreateAttempts.id,
      actorId: adminOrderCreateAttempts.actorId,
      requestKeyHash: adminOrderCreateAttempts.requestKeyHash,
      requestHash: adminOrderCreateAttempts.requestHash,
      orderId: adminOrderCreateAttempts.orderId,
    });

  if (reclaimed[0]?.id) {
    return {
      status: "claimed",
      attempt: {
        ...reclaimed[0],
        claimId,
      },
    };
  }

  const latest = await selectAttemptByKey(db, identity.requestKeyHash);
  await assertSameRequest(db, latest, identity);
  const latestReplay = replayAttempt<TResponse>(latest);
  if (latestReplay) return latestReplay;
  if (!latest) {
    throw new ServiceUnavailableError(
      "Manual order request state is unavailable. Retry with the same order form.",
    );
  }
  return { status: "processing", orderId: latest.orderId };
}

export async function resolveAdminOrderCreateAttempt<TResponse>(
  db: Database,
  identity: AdminOrderCreateAttemptIdentity,
): Promise<{ status: "replay"; response: TResponse } | null> {
  const existing = await selectAttemptByKey(db, identity.requestKeyHash);
  await assertSameRequest(db, existing, identity);
  return replayAttempt<TResponse>(existing);
}

export function buildAdminOrderCreateAttemptGuard(
  db: Database,
  attempt: ClaimedAdminOrderCreateAttempt,
) {
  return buildBatchGuard(db, sql`
    EXISTS (
      SELECT 1 FROM ${adminOrderCreateAttempts}
      WHERE ${adminOrderCreateAttempts.id} = ${attempt.id}
        AND ${adminOrderCreateAttempts.requestKeyHash} = ${attempt.requestKeyHash}
        AND ${adminOrderCreateAttempts.requestHash} = ${attempt.requestHash}
        AND ${adminOrderCreateAttempts.claimId} = ${attempt.claimId}
        AND ${adminOrderCreateAttempts.status} = 'processing'
    )
  `, ADMIN_CREATE_ATTEMPT_GUARD_MARKER);
}

export function buildAdminOrderCreateAttemptCommit(
  db: Database,
  attempt: ClaimedAdminOrderCreateAttempt,
  response: { id: string },
) {
  return db
    .update(adminOrderCreateAttempts)
    .set({
      status: "committed",
      responsePayload: JSON.stringify(response),
      claimId: null,
      claimExpiresAt: null,
      lastError: null,
      updatedAt: sql`unixepoch()`,
    })
    .where(
      and(
        eq(adminOrderCreateAttempts.id, attempt.id),
        eq(adminOrderCreateAttempts.claimId, attempt.claimId),
        eq(adminOrderCreateAttempts.status, "processing"),
      ),
    )
    .returning({ id: adminOrderCreateAttempts.id });
}

export async function markAdminOrderCreateAttemptFailed(
  db: Database,
  attempt: ClaimedAdminOrderCreateAttempt,
  error: unknown,
): Promise<void> {
  await db
    .update(adminOrderCreateAttempts)
    .set({
      status: "failed",
      claimId: null,
      claimExpiresAt: null,
      lastError: serializeAttemptError(error),
      updatedAt: sql`unixepoch()`,
    })
    .where(
      and(
        eq(adminOrderCreateAttempts.id, attempt.id),
        eq(adminOrderCreateAttempts.claimId, attempt.claimId),
        eq(adminOrderCreateAttempts.status, "processing"),
      ),
    );
}

export function isAdminOrderCreateAttemptGuardError(error: unknown): boolean {
  return isBatchGuardError(error, ADMIN_CREATE_ATTEMPT_GUARD_MARKER);
}

async function selectAttemptByKey(
  db: Database,
  requestKeyHash: string,
): Promise<AdminOrderCreateAttemptRow | undefined> {
  return db
    .select()
    .from(adminOrderCreateAttempts)
    .where(eq(adminOrderCreateAttempts.requestKeyHash, requestKeyHash))
    .get();
}

function replayAttempt<TResponse>(
  row: AdminOrderCreateAttemptRow | undefined,
): { status: "replay"; response: TResponse } | null {
  if (!row || row.status !== "committed") return null;
  if (!row.responsePayload) {
    throw new ServiceUnavailableError(
      "The original manual order response is unavailable. Contact support before retrying.",
    );
  }
  try {
    return { status: "replay", response: JSON.parse(row.responsePayload) as TResponse };
  } catch {
    throw new ServiceUnavailableError(
      "The original manual order response is unreadable. Contact support before retrying.",
    );
  }
}

async function assertSameRequest(
  db: Database,
  row: AdminOrderCreateAttemptRow | undefined,
  identity: AdminOrderCreateAttemptIdentity,
): Promise<void> {
  if (!row || row.requestHash === identity.requestHash) return;

  let authoritativeRow = row;
  if (isStaleProcessingAttempt(authoritativeRow)) {
    // Expiring a lease does not itself fence the old worker: the batch guard is
    // claim-id based. Move the exact stale claim to failed before authorizing a
    // new browser key, so an overdue worker cannot commit a duplicate order.
    await db
      .update(adminOrderCreateAttempts)
      .set({
        status: "failed",
        claimId: null,
        claimExpiresAt: null,
        lastError: "Superseded after the manual-order creation lease expired.",
        updatedAt: sql`unixepoch()`,
      })
      .where(
        and(
          eq(adminOrderCreateAttempts.requestKeyHash, identity.requestKeyHash),
          eq(adminOrderCreateAttempts.requestHash, authoritativeRow.requestHash),
          eq(adminOrderCreateAttempts.status, "processing"),
          or(
            isNull(adminOrderCreateAttempts.claimExpiresAt),
            lte(adminOrderCreateAttempts.claimExpiresAt, sql`unixepoch()`),
          ),
        ),
      );
    const latest = await selectAttemptByKey(db, identity.requestKeyHash);
    if (!latest) {
      throw new ServiceUnavailableError(
        "Manual order request state is unavailable. Retry with the same order form.",
      );
    }
    authoritativeRow = latest;
  }

  throw buildRequestMismatchError(authoritativeRow);
}

function buildRequestMismatchError(row: AdminOrderCreateAttemptRow): AppError {
  let message: string;
  let details: AdminOrderCreateRequestMismatchDetails;
  if (row.status === "committed") {
    message = "The earlier manual-order submission already created an order.";
    details = {
      state: "committed",
      canRetryWithNewKey: false,
      orderId: row.orderId,
    };
  } else if (row.status === "processing") {
    message = "The earlier manual-order submission is still being created.";
    details = {
      state: "processing",
      canRetryWithNewKey: false,
    };
  } else {
    message = "The earlier manual-order submission failed. The corrected details can be retried safely.";
    details = {
      state: "failed",
      canRetryWithNewKey: true,
    };
  }
  return new AppError(
    409,
    ADMIN_ORDER_CREATE_REQUEST_MISMATCH,
    message,
    details,
  );
}

function isFreshProcessingAttempt(
  row: AdminOrderCreateAttemptRow,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  return row.status === "processing" &&
    row.claimExpiresAt !== null &&
    row.claimExpiresAt > nowSeconds;
}

function isStaleProcessingAttempt(
  row: AdminOrderCreateAttemptRow,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  return row.status === "processing" &&
    (row.claimExpiresAt === null || row.claimExpiresAt <= nowSeconds);
}

function normalizeAdminOrderCreateRequest(input: CreateOrderInput): Record<string, unknown> {
  // The stored source: "Facebook" and "facebook" are the same request.
  const channelSource = normalizeOrderChannelSource(input.channelSource);
  return {
    version: 2,
    customerName: input.customerName.trim(),
    customerPhone: input.customerPhone.trim(),
    customerEmail: input.customerEmail?.trim().toLowerCase() ?? null,
    shippingAddress: input.shippingAddress?.trim() || null,
    city: input.city ?? null,
    zone: input.zone ?? null,
    area: input.area ?? null,
    cityName: input.cityName ?? null,
    zoneName: input.zoneName ?? null,
    areaName: input.areaName ?? null,
    notes: input.notes ?? null,
    // Every field that changes what is placed is the request: the same key sent with
    // another price, option, customer or payment is a different order, refused, never
    // replayed. A field left out hashes as before, so a retry across a deploy still replays.
    // `expectedTotal` is a guard, not content: staff resubmit a refused order at the new total.
    items: input.items.map((item) => ({
      productId: item.productId,
      variantId: item.variantId,
      quantity: item.quantity,
      ...(item.properties && item.properties.length > 0
        ? { properties: item.properties.map((property) => [property.key, property.value]) }
        : {}),
      ...(item.unitPriceMinor !== undefined ? { unitPriceMinor: item.unitPriceMinor } : {}),
      ...(item.purchaseOptions && item.purchaseOptions.length > 0 ? { purchaseOptions: [...item.purchaseOptions].sort() } : {}),
    })),
    ...(input.shippingMethodId ? { shippingMethodId: input.shippingMethodId } : {}),
    ...(channelSource ? { channelSource } : {}),
    ...(input.customerId ? { customerId: input.customerId } : {}),
    ...(input.attributes && Object.keys(input.attributes).length > 0
      ? { attributes: Object.entries(input.attributes).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)) }
      : {}),
    ...(input.paymentMethod ? { paymentMethod: input.paymentMethod } : {}),
    ...(input.paymentTermsDays != null ? { paymentTermsDays: input.paymentTermsDays } : {}),
    ...(input.paid ? { paid: { via: input.paid.via, reference: input.paid.reference?.trim() || null } } : {}),
    // A sale's location, staff and tenders are what it records: another set is another sale.
    ...(input.pointOfSale ? { pointOfSale: {
      locationId: input.pointOfSale.locationId,
      staffMemberId: input.pointOfSale.staffMemberId ?? null,
      tenders: input.pointOfSale.tenders.map((tender) => [tender.via, tender.amountMinor, tender.reference?.trim() || null]),
    } } : {}),
    ...(input.abandonedCheckoutId ? { abandonedCheckoutId: input.abandonedCheckoutId } : {}),
    // The online store is the default: naming it is the same request.
    ...(input.salesChannelId && input.salesChannelId !== ONLINE_STORE_CHANNEL_ID ? { salesChannelId: input.salesChannelId } : {}),
    discountAmount: input.discountAmount == null ? null : normalizeAmount(input.discountAmount),
    shippingCharge: normalizeAmount(input.shippingCharge),
    // The structured addresses decide where it ships, how it is taxed and what is
    // printed: another country, postal code or billing address is another order.
    ...presentAddress(input),
    // Who placed it: staff are the default, so naming them is the same request.
    ...(input.channel && input.channel !== "admin" ? { channel: input.channel } : {}),
  };
}

/** The structured address fields a request names, trimmed; an absent or empty one is left out, so it hashes as before. */
function presentAddress(input: CreateOrderInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const text = (key: string, value: string | null | undefined, upper = false) => {
    const trimmed = value?.trim();
    if (trimmed) out[key] = upper ? trimmed.toUpperCase() : trimmed;
  };
  text("shippingCountryCode", input.shippingCountryCode, true);
  text("shippingAddressLine2", input.shippingAddressLine2);
  text("shippingDependentLocality", input.shippingDependentLocality);
  text("shippingLocality", input.shippingLocality);
  text("shippingAdminArea", input.shippingAdminArea);
  text("shippingPostalCode", input.shippingPostalCode);
  text("shippingCompany", input.shippingCompany);
  if (input.skipAddressValidation) out.skipAddressValidation = true;
  if (typeof input.billingSameAsShipping === "boolean") out.billingSameAsShipping = input.billingSameAsShipping;
  text("billingCountryCode", input.billingCountryCode, true);
  text("billingName", input.billingName);
  text("billingCompany", input.billingCompany);
  text("billingAddress", input.billingAddress);
  text("billingAddressLine2", input.billingAddressLine2);
  text("billingDependentLocality", input.billingDependentLocality);
  text("billingLocality", input.billingLocality);
  text("billingAdminArea", input.billingAdminArea);
  text("billingPostalCode", input.billingPostalCode);
  return out;
}

function normalizeAmount(amount: number): number {
  return Math.round(amount * 1_000_000) / 1_000_000;
}

function serializeAttemptError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ATTEMPT_ERROR_LENGTH);
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
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
