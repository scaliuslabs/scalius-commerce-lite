import type { Database } from "@scalius/database/client";
import { buildBatchGuard } from "@scalius/database/client";
import { adminOrderCreateAttempts } from "@scalius/database/schema";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { ConflictError, ServiceUnavailableError } from "@scalius/core/errors";
import { generateOrderId } from "@scalius/shared/order-utils";
import type { CreateOrderInput } from "./orders.validation";

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
const ADMIN_CREATE_ATTEMPT_GUARD_MARKER = "ADMIN_ORDER_CREATE_ATTEMPT_CONFLICT";

type AdminOrderCreateAttemptRow = typeof adminOrderCreateAttempts.$inferSelect;

export async function buildAdminOrderCreateAttemptIdentity(
  input: CreateOrderInput,
  actorId: string | null,
): Promise<AdminOrderCreateAttemptIdentity> {
  const requestKey = input.requestKey.trim();
  const actorScope = actorId ?? "unknown-admin";
  return {
    actorId,
    requestKeyHash: await sha256Hex(`${actorScope}:${requestKey}`),
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
  assertSameRequest(existing, identity);
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
  assertSameRequest(latest, identity);
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
  assertSameRequest(existing, identity);
  return replayAttempt<TResponse>(existing);
}

export function buildAdminOrderCreateAttemptGuard(
  db: Database,
  attempt: ClaimedAdminOrderCreateAttempt,
) {
  return buildBatchGuard(db, sql`
    CASE WHEN EXISTS (
      SELECT 1 FROM ${adminOrderCreateAttempts}
      WHERE ${adminOrderCreateAttempts.id} = ${attempt.id}
        AND ${adminOrderCreateAttempts.requestKeyHash} = ${attempt.requestKeyHash}
        AND ${adminOrderCreateAttempts.requestHash} = ${attempt.requestHash}
        AND ${adminOrderCreateAttempts.claimId} = ${attempt.claimId}
        AND ${adminOrderCreateAttempts.status} = 'processing'
    ) THEN 1 ELSE json_extract(${ADMIN_CREATE_ATTEMPT_GUARD_MARKER}, '$') END
  `);
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
  return error instanceof Error &&
    new RegExp(`${ADMIN_CREATE_ATTEMPT_GUARD_MARKER}|malformed json`, "i").test(error.message);
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

function assertSameRequest(
  row: AdminOrderCreateAttemptRow | undefined,
  identity: AdminOrderCreateAttemptIdentity,
): void {
  if (!row || row.requestHash === identity.requestHash) return;
  throw new ConflictError(
    "This manual-order request was already used for different details. Discard this form and start a new order.",
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

function normalizeAdminOrderCreateRequest(input: CreateOrderInput): Record<string, unknown> {
  return {
    version: 2,
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
    })),
    discountAmount: input.discountAmount == null ? null : normalizeAmount(input.discountAmount),
    shippingCharge: normalizeAmount(input.shippingCharge),
  };
}

function normalizeAmount(amount: number): number {
  return Math.round(amount * 1_000_000) / 1_000_000;
}

function serializeAttemptError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ATTEMPT_ERROR_LENGTH);
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function stableStringify(value: unknown): string {
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
