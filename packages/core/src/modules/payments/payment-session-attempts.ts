import type { Database } from "@scalius/database/client";
import { paymentSessionAttempts } from "@scalius/database/schema";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { ConflictError, ServiceUnavailableError } from "@scalius/core/errors";
import type { PaymentGateway, PaymentType } from "./types";

export type PaymentSessionGateway = Exclude<PaymentGateway, "cod">;

export interface PaymentSessionAttemptIdentity {
  attemptKey: string;
  requestHash: string;
  transactionSuffix: string;
  orderId: string;
  gateway: PaymentSessionGateway;
  paymentType: PaymentType;
  amount: number;
  currency: string;
}

export interface BuildPaymentSessionAttemptIdentityInput {
  orderId: string;
  gateway: PaymentSessionGateway;
  paymentType: PaymentType;
  amount: number;
  currency: string;
  receiptToken?: string;
  proof?: {
    kind: "receipt" | "customer_account";
    value: string;
  };
  requestContext?: Record<string, unknown>;
}

export interface ClaimPaymentSessionAttemptInput extends PaymentSessionAttemptIdentity {
  providerCorrelationId?: string | null;
}

export interface ClaimedPaymentSessionAttempt {
  id: string;
  attemptKey: string;
  claimId: string;
  providerCorrelationId?: string | null;
}

export type PaymentSessionAttemptClaimResult<TResponse> =
  | { status: "claimed"; attempt: ClaimedPaymentSessionAttempt }
  | { status: "replay"; response: TResponse };

const PAYMENT_SESSION_ATTEMPT_LEASE_SECONDS = 5 * 60;
const MAX_ERROR_LENGTH = 500;

type AttemptRow = typeof paymentSessionAttempts.$inferSelect;

export async function buildPaymentSessionAttemptIdentity(
  input: BuildPaymentSessionAttemptIdentityInput,
): Promise<PaymentSessionAttemptIdentity> {
  const proof = resolveAttemptProof(input);
  const proofHash = await sha256Hex(proof.value);
  const currency = input.currency.trim().toLowerCase();
  const amount = normalizeAmount(input.amount);
  const canonical = proof.kind === "receipt"
    ? {
        orderId: input.orderId,
        gateway: input.gateway,
        paymentType: input.paymentType,
        amount,
        currency,
        receiptTokenHash: proofHash,
        requestContext: input.requestContext ?? null,
      }
    : {
        orderId: input.orderId,
        gateway: input.gateway,
        paymentType: input.paymentType,
        amount,
        currency,
        proofKind: proof.kind,
        proofHash,
        requestContext: input.requestContext ?? null,
      };
  const requestHash = await sha256Hex(stableStringify(canonical));

  return {
    attemptKey: `payment_session:${input.gateway}:${requestHash}`,
    requestHash,
    transactionSuffix: requestHash.slice(0, 8).toUpperCase(),
    orderId: input.orderId,
    gateway: input.gateway,
    paymentType: input.paymentType,
    amount,
    currency,
  };
}

function resolveAttemptProof(input: BuildPaymentSessionAttemptIdentityInput): { kind: "receipt" | "customer_account"; value: string } {
  const proof = input.proof ?? (input.receiptToken ? { kind: "receipt" as const, value: input.receiptToken } : null);
  if (!proof?.value?.trim()) {
    throw new ServiceUnavailableError("Payment session proof is unavailable. Please try again.");
  }
  return {
    kind: proof.kind,
    value: proof.value.trim(),
  };
}

export async function claimPaymentSessionAttempt<TResponse>(
  db: Database,
  input: ClaimPaymentSessionAttemptInput,
): Promise<PaymentSessionAttemptClaimResult<TResponse>> {
  const claimId = createPaymentSessionClaimId();
  const inserted = await db
    .insert(paymentSessionAttempts)
    .values({
      id: createPaymentSessionAttemptId(),
      attemptKey: input.attemptKey,
      orderId: input.orderId,
      gateway: input.gateway,
      paymentType: input.paymentType,
      amount: input.amount,
      currency: input.currency,
      requestHash: input.requestHash,
      status: "processing",
      providerCorrelationId: input.providerCorrelationId ?? null,
      attempts: 1,
      claimId,
      claimExpiresAt: sql`unixepoch() + ${PAYMENT_SESSION_ATTEMPT_LEASE_SECONDS}`,
      lastError: null,
      createdAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    })
    .onConflictDoNothing()
    .returning({
      id: paymentSessionAttempts.id,
      attemptKey: paymentSessionAttempts.attemptKey,
      providerCorrelationId: paymentSessionAttempts.providerCorrelationId,
    });

  if (inserted[0]?.id) {
    return {
      status: "claimed",
      attempt: {
        id: inserted[0].id,
        attemptKey: inserted[0].attemptKey,
        claimId,
        providerCorrelationId: inserted[0].providerCorrelationId,
      },
    };
  }

  const existing = await selectPaymentSessionAttemptByKey(db, input.attemptKey);
  const replay = replayPaymentSessionAttempt<TResponse>(existing);
  if (replay) return replay;

  const reclaimed = await db
    .update(paymentSessionAttempts)
    .set({
      status: "processing",
      claimId,
      claimExpiresAt: sql`unixepoch() + ${PAYMENT_SESSION_ATTEMPT_LEASE_SECONDS}`,
      providerCorrelationId: input.providerCorrelationId ?? existing?.providerCorrelationId ?? null,
      attempts: sql`${paymentSessionAttempts.attempts} + 1`,
      lastError: null,
      updatedAt: sql`unixepoch()`,
    })
    .where(
      and(
        eq(paymentSessionAttempts.attemptKey, input.attemptKey),
        or(
          eq(paymentSessionAttempts.status, "failed"),
          and(
            eq(paymentSessionAttempts.status, "processing"),
            or(
              isNull(paymentSessionAttempts.claimExpiresAt),
              lte(paymentSessionAttempts.claimExpiresAt, sql`unixepoch()`),
            ),
          ),
        ),
      ),
    )
    .returning({
      id: paymentSessionAttempts.id,
      attemptKey: paymentSessionAttempts.attemptKey,
      providerCorrelationId: paymentSessionAttempts.providerCorrelationId,
    });

  if (reclaimed[0]?.id) {
    return {
      status: "claimed",
      attempt: {
        id: reclaimed[0].id,
        attemptKey: reclaimed[0].attemptKey,
        claimId,
        providerCorrelationId: reclaimed[0].providerCorrelationId,
      },
    };
  }

  const latest = await selectPaymentSessionAttemptByKey(db, input.attemptKey);
  const latestReplay = replayPaymentSessionAttempt<TResponse>(latest);
  if (latestReplay) return latestReplay;

  if (!latest) {
    throw new ServiceUnavailableError("Payment session attempt state is unavailable. Please try again.");
  }

  throw new ConflictError("A payment session is already being created for this order. Please try again shortly.");
}

export async function markPaymentSessionAttemptCreated<TResponse>(
  db: Database,
  attempt: ClaimedPaymentSessionAttempt,
  options: {
    providerSessionId?: string | null;
    providerCorrelationId?: string | null;
    response: TResponse;
  },
): Promise<void> {
  const rows = await db
    .update(paymentSessionAttempts)
    .set({
      status: "created",
      providerSessionId: options.providerSessionId ?? null,
      providerCorrelationId: options.providerCorrelationId ?? attempt.providerCorrelationId ?? null,
      responsePayload: JSON.stringify(options.response),
      claimId: null,
      claimExpiresAt: null,
      lastError: null,
      updatedAt: sql`unixepoch()`,
    })
    .where(
      and(
        eq(paymentSessionAttempts.id, attempt.id),
        eq(paymentSessionAttempts.claimId, attempt.claimId),
      ),
    )
    .returning({ id: paymentSessionAttempts.id });

  if (rows.length === 0) {
    throw new ConflictError("Payment session attempt claim was lost before the provider response was stored.");
  }
}

export async function markPaymentSessionAttemptFailed(
  db: Database,
  attempt: ClaimedPaymentSessionAttempt,
  error: unknown,
): Promise<void> {
  await db
    .update(paymentSessionAttempts)
    .set({
      status: "failed",
      claimId: null,
      claimExpiresAt: null,
      lastError: serializeAttemptError(error),
      updatedAt: sql`unixepoch()`,
    })
    .where(
      and(
        eq(paymentSessionAttempts.id, attempt.id),
        eq(paymentSessionAttempts.claimId, attempt.claimId),
      ),
    );
}

async function selectPaymentSessionAttemptByKey(
  db: Database,
  attemptKey: string,
): Promise<AttemptRow | undefined> {
  return await db
    .select()
    .from(paymentSessionAttempts)
    .where(eq(paymentSessionAttempts.attemptKey, attemptKey))
    .get();
}

function replayPaymentSessionAttempt<TResponse>(
  row: AttemptRow | undefined,
): PaymentSessionAttemptClaimResult<TResponse> | null {
  if (!row || row.status !== "created") return null;
  if (!row.responsePayload) {
    throw new ServiceUnavailableError("Payment session replay payload is unavailable. Please try again.");
  }

  try {
    return {
      status: "replay",
      response: JSON.parse(row.responsePayload) as TResponse,
    };
  } catch {
    throw new ServiceUnavailableError("Payment session replay payload is unreadable. Please try again.");
  }
}

function createPaymentSessionAttemptId(): string {
  return `psa_${crypto.randomUUID()}`;
}

function createPaymentSessionClaimId(): string {
  return `psac_${crypto.randomUUID()}`;
}

function serializeAttemptError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_LENGTH);
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
