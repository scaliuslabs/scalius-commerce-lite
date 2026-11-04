// Payments without the buyer: charging a saved payment method off-session,
// and capturing or voiding an authorization. Core runs no subscription
// logic; an app (subscriptions, B2B "authorize at order, capture at ship")
// calls these through the stable app API.
//
// Every command claims locally before the provider call and records the
// outcome after it, in `payment_session_attempts` (the session attempt
// table: its per-order single-flight index and its lease are the
// hosted-payment lock every order writer already honours):
//
// - A charge's attempt key derives from the caller's Idempotency-Key and
//   the order, and is the provider's idempotency key: a retry with the same
//   key replays the recorded outcome (succeeded, authorized, pending or
//   declined) and never charges again. A capture's and a void's key is the
//   authorization's (`capture:<payment id>`, `void:<payment id>`), so no two
//   callers can capture one hold twice.
// - A call that may have reached the provider but gave no answer leaves the
//   attempt `uncertain` and answers 503 `payment_outcome_unknown`. Repeating
//   the same request asks the provider again under the same key (it answers
//   its first outcome); while the outcome is unknown, or a command is
//   `pending` its webhook, the order takes no other charge.
// - An open command always ends (command-attempts.ts): the provider's fact
//   settles it as the kernel applies it, a repeat after a minute asks the
//   provider again under the same key, the scheduled sweep looks the
//   payment up, and after three days without an answer it is expired.
// - A provider-authenticated outcome goes through the one payment kernel:
//   the event is claimed once in `webhook_events` and applied
//   (`processPaymentConfirmed` / `processPaymentAuthorized`), exactly as a
//   webhook would be. A void marks the authorization `cancelled`.
// - A charge takes new money, so its gateway must be on for payments; a
//   capture, a void and a lookup act on money already taken and need only
//   the gateway's readable credentials (`canOperateExistingPayments`).
import { and, eq, inArray, lte, or, isNull, sql, type SQL } from "drizzle-orm";
import {
  orderPayments,
  orders,
  paymentSessionAttempts,
  PaymentRecordStatus,
} from "@scalius/database/schema";
import { buildBatchGuard, isBatchGuardError, safeBatch, type Database } from "@scalius/database/client";
import { AppError, ConflictError, NotFoundError, ServiceUnavailableError, ValidationError } from "@scalius/core/errors";
import { sha256Hex } from "@scalius/shared/hash";
import { providerErrorOf } from "@scalius/shared/plugins/providers/kinds";
import type { PaymentType } from "./types";
import { buildPaymentCorrelationId } from "./gateways/correlation";
import {
  canOperateExistingPayments,
  gatewayHasCapability,
  type GatewaySettings,
  type PaymentEvent,
  type PaymentGateway,
} from "./gateways/port";
import { getGatewayAmountIssue, paymentProvidersFor, type PaymentProviders, type PaymentProvidersSource } from "./gateways/registry";
import { getUnpayableOrderReason } from "./payable-order";
import { acceptsProviderPayment, inferPaymentType, releaseAuthorization, validateIncomingPaymentState } from "./process-payment";
import { readCustomerPaymentMethod, savedMethodVisibleTo, type SavedMethodActor } from "./saved-payment-methods";
import { resolveOrderCurrencySnapshot } from "./order-currency";
import { hasActiveShipmentClaim, SHIPMENT_CLAIM_CONFLICT_MESSAGE, shipmentClaimShipmentStatusSql } from "../order-kernel";
import {
  closeCommandAttempt,
  commandAttemptKeyCondition,
  COMMAND_EXPIRY_SECONDS,
  commandKindOf,
  commandOutcomeFromLedger,
  commandOutcomeOf,
  convergePaymentCommands,
  convergePaymentCommandsAfterFact,
  isOpenCommandStatus,
  OPEN_COMMAND_STATUSES,
  PENDING_RECHECK_SECONDS,
  refreshFromLedger,
  settleCommandFromLedger,
  type CommandAttemptRow,
  type SavedMethodPaymentOutcomeKind,
  type StoredCommandOutcome,
} from "./command-attempts";

export type { SavedMethodPaymentOutcomeKind } from "./command-attempts";

/** The provider call's deadline and the request timeout it is told. */
const PROVIDER_DEADLINE_MS = 12_000;
const PROVIDER_REQUEST_TIMEOUT_MS = 11_000;
const LEASE_SECONDS = 5 * 60;
const CLAIM_GUARD = "saved_method_charge_blocked";
/** The sweep looks an open command up again after half its age, at least five minutes and at most six hours apart. */
const SWEEP_MIN_DELAY_SECONDS = 5 * 60;
const SWEEP_MAX_DELAY_SECONDS = 6 * 60 * 60;

/** What the kernel applied a provider-authenticated event as (the webhook claim's outcome). */
export type AppliedPaymentEventStatus = "processed" | "manual_reconciliation" | "retrying" | "failed" | "duplicate";

/**
 * Claims a provider-authenticated event once in `webhook_events` and applies
 * it through the kernel before returning (the API's `webhook_events` claim).
 */
export type ApplyProviderPaymentEvent = (input: { provider: string; event: PaymentEvent; source: string }) => Promise<AppliedPaymentEventStatus>;

/** The outcome of a charge, a capture or a void, as recorded and replayed. */
export interface SavedMethodPaymentOutcome {
  outcome: SavedMethodPaymentOutcomeKind;
  orderId: string;
  providerId: string;
  /** The order payment row, once the provider's event landed. */
  paymentId: string | null;
  amountMinor: number;
  currency: string;
  /** A decline's safe reason and short code. */
  declineReason: string | null;
  declineCode: string | null;
  /** True when this answers a request already handled. */
  replayed: boolean;
}

type StoredOutcome = StoredCommandOutcome;

export interface PaymentCommandDeps {
  providers: PaymentProvidersSource;
  encryptionKey: string | undefined;
  applyEvent: ApplyProviderPaymentEvent;
}
type CommandDeps = PaymentCommandDeps;

type AttemptRow = CommandAttemptRow;

interface ClaimedAttempt {
  id: string;
  claimId: string;
  attemptKey: string;
}

function unknownOutcome(label: string): AppError {
  return new AppError(503, "payment_outcome_unknown", `${label} did not answer. Send the same request again with the same Idempotency-Key: it asks ${label} again and never charges twice.`);
}

function inProgress(): AppError {
  return new AppError(409, "payment_in_progress", "A payment for this order is in progress. Try again shortly.");
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

async function withProviderDeadline<T>(run: (signal: AbortSignal, requestTimeoutMs: number) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_DEADLINE_MS);
  try {
    return await run(controller.signal, PROVIDER_REQUEST_TIMEOUT_MS);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The gateway for a command. A charge (`newPayment`) needs it ready to take
 * payments; a capture or a void acts on money already held and needs only
 * readable credentials, so turning the gateway off never strands a hold.
 */
async function commandGateway(
  db: Database,
  deps: CommandDeps,
  providerId: string,
  capability: "vault" | "manualCapture",
  use: "newPayment" | "existingPayment",
): Promise<{ gateway: PaymentGateway; providers: PaymentProviders; settings: GatewaySettings }> {
  const providers = await paymentProvidersFor(deps.providers, providerId);
  const gateway = providers.get(providerId);
  if (!gateway || !gatewayHasCapability(gateway, capability)) {
    throw new ValidationError(capability === "vault"
      ? "This payment method's provider cannot charge saved payment methods."
      : "This payment's provider cannot capture or void authorizations.");
  }
  const settings = await gateway.loadSettings(db, deps.encryptionKey);
  if (use === "newPayment") {
    if (!gateway.readiness(settings).usable || !settings) {
      throw new ServiceUnavailableError(`${gateway.label} is not ready to take payments. Check its settings.`);
    }
    return { gateway, providers, settings };
  }
  if (!canOperateExistingPayments(gateway, settings)) {
    throw new ServiceUnavailableError(`${gateway.label} cannot be reached with its saved credentials. Check its settings.`);
  }
  return { gateway, providers, settings };
}

async function readAttempt(db: Database, attemptKey: string): Promise<AttemptRow | undefined> {
  return db.select().from(paymentSessionAttempts).where(eq(paymentSessionAttempts.attemptKey, attemptKey)).get();
}

function storedOutcome(row: AttemptRow): StoredOutcome | null {
  if (!row.responsePayload) return null;
  try {
    return JSON.parse(row.responsePayload) as StoredOutcome;
  } catch {
    return null;
  }
}

/** Whether an open command is due another look (a repeat asks its provider again; the sweep looks it up). */
function commandDue(row: AttemptRow, now = nowSeconds()): boolean {
  return row.claimExpiresAt === null || Number(row.claimExpiresAt) <= now;
}

interface Replayed {
  outcome: SavedMethodPaymentOutcome;
  /** A `pending` command due another look: the caller asks the provider again under the same key. */
  recheck: boolean;
}

/**
 * A recorded outcome, refreshed: an open command whose provider fact already
 * landed is settled from the ledger first (and so answers what the payment
 * became). Null when there is nothing to replay (no outcome yet, or a
 * failed call the same key may repeat).
 */
async function replay(db: Database, row: AttemptRow): Promise<Replayed | null> {
  let current = row;
  if (isOpenCommandStatus(row.status)) {
    const settled = await settleCommandFromLedger(db, row);
    if (settled) return { outcome: { ...stripRef(settled), replayed: true }, recheck: false };
    current = (await readAttempt(db, row.attemptKey)) ?? row;
  }
  if (current.status !== "created" && current.status !== "pending") return null;
  const recorded = storedOutcome(current);
  if (!recorded) throw new ServiceUnavailableError("The recorded payment outcome is unreadable. Try again.");
  // Closed by the batch that landed its payment: the ledger says what it became.
  const stored = current.status === "created" ? await refreshFromLedger(db, current, recorded) : recorded;
  return { outcome: { ...stripRef(stored), replayed: true }, recheck: current.status === "pending" && commandDue(current) };
}

function isFreshProcessing(row: AttemptRow): boolean {
  return row.status === "processing" && row.claimExpiresAt !== null && Number(row.claimExpiresAt) > nowSeconds();
}

function isConstraintError(error: unknown): boolean {
  for (let current: unknown = error; current; current = (current as { cause?: unknown }).cause) {
    const message = current instanceof Error ? current.message : String(current);
    if (/constraint|unique/i.test(message)) return true;
    if (!(current instanceof Error)) return false;
  }
  return false;
}

/**
 * Claim the attempt: a new row, or the same key's row again when its last
 * call failed before reaching the provider, left the outcome unknown, is
 * `pending` and due another look, or its lease expired. `guard` must hold
 * in the same batch (the order still takes this payment). Another live
 * payment on the order is 409.
 */
async function claimAttempt(
  db: Database,
  input: {
    attemptKey: string;
    requestHash: string;
    orderId: string;
    gateway: string;
    paymentType: PaymentType;
    amountMinor: number;
    currency: string;
    correlationId: string;
    guard: SQL;
    guardMessage: string;
  },
): Promise<ClaimedAttempt> {
  const claimId = `psac_${crypto.randomUUID()}`;
  const lease = sql`unixepoch() + ${LEASE_SECONDS}`;
  const guard = buildBatchGuard(db, input.guard, CLAIM_GUARD);
  const lapsed = or(isNull(paymentSessionAttempts.claimExpiresAt), lte(paymentSessionAttempts.claimExpiresAt, sql`unixepoch()`));
  let rows: Array<{ id: string }>;
  try {
    const result = await safeBatch(db, [
      guard,
      db.insert(paymentSessionAttempts).values({
        id: `psa_${crypto.randomUUID()}`,
        attemptKey: input.attemptKey,
        orderId: input.orderId,
        gateway: input.gateway,
        paymentType: input.paymentType,
        amountMinor: input.amountMinor,
        currency: input.currency,
        requestHash: input.requestHash,
        status: "processing",
        providerCorrelationId: input.correlationId,
        attempts: 1,
        claimId,
        claimExpiresAt: lease,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
      }).onConflictDoNothing().returning({ id: paymentSessionAttempts.id }),
    ]) as unknown as [unknown, Array<{ id: string }>];
    rows = result[1];
    if (rows.length === 0) {
      const reclaimed = await safeBatch(db, [
        guard,
        db.update(paymentSessionAttempts).set({
          status: "processing",
          claimId,
          claimExpiresAt: lease,
          attempts: sql`${paymentSessionAttempts.attempts} + 1`,
          lastError: null,
          updatedAt: sql`unixepoch()`,
        }).where(and(
          eq(paymentSessionAttempts.attemptKey, input.attemptKey),
          eq(paymentSessionAttempts.requestHash, input.requestHash),
          or(
            inArray(paymentSessionAttempts.status, ["failed", "uncertain"]),
            and(eq(paymentSessionAttempts.status, "pending"), lapsed),
            and(eq(paymentSessionAttempts.status, "processing"), lapsed),
          ),
        )).returning({ id: paymentSessionAttempts.id }),
      ]) as unknown as [unknown, Array<{ id: string }>];
      rows = reclaimed[1];
    }
  } catch (error) {
    if (isBatchGuardError(error, CLAIM_GUARD)) throw new AppError(409, "payment_not_possible", input.guardMessage);
    // The order's single-flight index: another payment is being set up.
    if (isConstraintError(error)) throw inProgress();
    throw error;
  }
  if (rows.length === 0) throw inProgress();
  return { id: rows[0]!.id, claimId, attemptKey: input.attemptKey };
}

/**
 * Record a call's outcome. An open one (`pending`, `uncertain`) is due
 * another look after `PENDING_RECHECK_SECONDS` (`claim_expires_at` is its
 * next look while it is open).
 */
async function finishAttempt(
  db: Database,
  attempt: ClaimedAttempt,
  status: "created" | "pending" | "uncertain" | "failed",
  values: { outcome?: StoredOutcome; providerRef?: string | null; error?: string },
): Promise<void> {
  await db.update(paymentSessionAttempts).set({
    status,
    ...(values.outcome ? { responsePayload: JSON.stringify(values.outcome) } : {}),
    ...(values.providerRef ? { providerSessionId: values.providerRef } : {}),
    claimId: null,
    claimExpiresAt: isOpenCommandStatus(status) ? sql`unixepoch() + ${PENDING_RECHECK_SECONDS}` : null,
    lastError: values.error ? values.error.slice(0, 500) : null,
    updatedAt: sql`unixepoch()`,
  }).where(and(eq(paymentSessionAttempts.id, attempt.id), eq(paymentSessionAttempts.claimId, attempt.claimId)));
}

/** A provider failure after the claim: certain ones end the attempt, anything else leaves its outcome unknown. */
async function providerFailure(db: Database, attempt: ClaimedAttempt, error: unknown, label: string): Promise<never> {
  const failure = providerErrorOf(error);
  if (failure && !failure.uncertain && failure.category !== "declined") {
    await finishAttempt(db, attempt, "failed", { error: failure.message });
    throw failure.category === "misconfigured"
      ? new ServiceUnavailableError(`${label} is not configured to take this payment: ${failure.message}`)
      : new ServiceUnavailableError(`${label} could not take the payment now. Try again shortly.`);
  }
  await finishAttempt(db, attempt, "uncertain", { error: failure?.message ?? (error instanceof Error ? error.name : "unknown") });
  throw unknownOutcome(label);
}

async function paymentRowFor(db: Database, provider: string, providerRef: string): Promise<{ id: string; status: string } | undefined> {
  return db.select({ id: orderPayments.id, status: orderPayments.status })
    .from(orderPayments)
    .where(and(eq(orderPayments.paymentMethod, provider), eq(orderPayments.providerRef, providerRef)))
    .get();
}

/** Apply the provider's event through the kernel and read what it became. */
async function applyOutcome(
  db: Database,
  deps: CommandDeps,
  input: { gateway: PaymentGateway; event: PaymentEvent; orderId: string; source: string; base: Omit<StoredOutcome, "outcome" | "paymentId" | "providerRef"> },
): Promise<StoredOutcome> {
  const { event, gateway } = input;
  if (event.orderId !== input.orderId) {
    throw new AppError(503, "provider_invalid_response", `${gateway.label} answered for another order.`);
  }
  await deps.applyEvent({ provider: gateway.id, event, source: input.source });
  const row = await paymentRowFor(db, gateway.id, event.providerRef);
  const outcome: SavedMethodPaymentOutcomeKind = row?.status === PaymentRecordStatus.SUCCEEDED
    ? "succeeded"
    : row?.status === PaymentRecordStatus.AUTHORIZED ? "authorized" : "pending";
  return { ...input.base, outcome, paymentId: row?.id ?? null, providerRef: event.providerRef };
}

// ── Charge a saved method ───────────────────────────────────────────────────

export interface ChargeSavedPaymentMethodInput extends CommandDeps {
  orderId: string;
  paymentMethodId: string;
  /**
   * Who charges (security audit N3): staff any method; an app only a method
   * kept for its own purchase option (another app's, or one no app owns,
   * reads as not found). A buyer never charges off-session.
   */
  actor: Exclude<SavedMethodActor, { kind: "customer" }>;
  /** Default: the order's balance due. It must be an amount the order takes (its balance, or its deposit). */
  amountMinor?: number;
  /** `manual` only authorizes; capture it later. Default `automatic`. */
  capture?: "automatic" | "manual";
  /** The caller's retry key, scoped to the caller and operation (8 to 200 characters). */
  requestKey: string;
  /** The order `version` the caller read; a different one is refused (409) before the provider is called. */
  expectedVersion?: number;
}

/**
 * Charge a customer's saved payment method for an order with money due: the
 * order is not cancelled, belongs to the method's customer, and takes a
 * provider payment (`acceptsProviderPayment`: its own gateway, or an
 * invoice with nothing paid yet, which the landed payment switches to the
 * provider). Idempotent by `requestKey`; see the file header.
 */
export async function chargeSavedPaymentMethod(
  db: Database,
  input: ChargeSavedPaymentMethodInput,
): Promise<SavedMethodPaymentOutcome> {
  const requestKey = input.requestKey.trim();
  if (requestKey.length < 8 || requestKey.length > 200) throw new ValidationError("An Idempotency-Key of 8 to 200 characters is required.");
  const capture = input.capture ?? "automatic";
  if (input.amountMinor !== undefined && (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)) {
    throw new ValidationError("Enter a positive amount in minor units.");
  }
  const attemptKey = `pcharge_${(await sha256Hex(`${input.orderId}\n${requestKey}`)).slice(0, 48)}`;
  const requestHash = await sha256Hex(JSON.stringify([input.orderId, input.paymentMethodId, input.amountMinor ?? null, capture]));

  let existing = await readAttempt(db, attemptKey);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new AppError(422, "idempotency_key_reused", "This Idempotency-Key was used for a different charge.");
    }
    const replayed = await replay(db, existing);
    if (replayed && !replayed.recheck) return replayed.outcome;
    if (!replayed && isFreshProcessing(existing)) throw inProgress();
    existing = (await readAttempt(db, attemptKey)) ?? existing;
  }

  const method = await readCustomerPaymentMethod(db, input.paymentMethodId);
  if (!method || !savedMethodVisibleTo(method, input.actor)) throw new NotFoundError("Saved payment method not found");
  // A charge whose outcome is unknown, or still pending, is asked again exactly as it was sent.
  const resuming = existing !== undefined && existing.status !== "failed";

  const order = await db.select({
    id: orders.id,
    status: orders.status,
    paymentMethod: orders.paymentMethod,
    paymentStatus: orders.paymentStatus,
    paidAmountMinor: orders.paidAmountMinor,
    balanceDueMinor: orders.balanceDueMinor,
    totalAmountMinor: orders.totalAmountMinor,
    accountOwnerCustomerId: orders.accountOwnerCustomerId,
    version: orders.version,
    deletedAt: orders.deletedAt,
    shipmentClaimId: orders.shipmentClaimId,
    shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
    // The claim's own attempt row: an expired claim with none (or a failed one) does not lock.
    shipmentClaimShipmentStatus: shipmentClaimShipmentStatusSql(),
    currencyCode: orders.currencyCode,
    currencyDecimalPlaces: orders.currencyDecimalPlaces,
  }).from(orders).where(eq(orders.id, input.orderId)).get();
  if (!order) throw new NotFoundError("Order not found");
  if (!order.accountOwnerCustomerId || order.accountOwnerCustomerId !== method.customerId) {
    throw new AppError(422, "payment_method_customer_mismatch", "This saved payment method belongs to another customer than the order's.");
  }
  const currency = resolveOrderCurrencySnapshot(order).code;

  let paymentType: PaymentType;
  let amountMinor: number;
  if (resuming) {
    paymentType = existing!.paymentType as PaymentType;
    amountMinor = existing!.amountMinor;
  } else {
    if (method.status !== "active") throw new NotFoundError("Saved payment method not found");
    if (input.expectedVersion !== undefined && input.expectedVersion !== order.version) {
      throw new ConflictError("This order changed. Read it again before charging it.");
    }
    if (hasActiveShipmentClaim(order)) throw new AppError(409, "conflict", SHIPMENT_CLAIM_CONFLICT_MESSAGE);
    const unpayable = getUnpayableOrderReason(order);
    if (unpayable) throw new ValidationError(unpayable);
    if (order.balanceDueMinor <= 0) throw new ValidationError("Nothing is due on this order.");
    if (!acceptsProviderPayment(order, method.providerId)) {
      throw new ValidationError(order.paidAmountMinor > 0 && order.paymentMethod !== method.providerId
        ? "This order is partly paid another way; record the rest of its payments instead."
        : "This order's payment method does not take a payment from this provider.");
    }
    amountMinor = input.amountMinor ?? order.balanceDueMinor;
    const inferred = await inferPaymentType(db, order, amountMinor);
    if (!inferred) throw new ValidationError(`Charge an amount the order takes: its balance due is ${order.balanceDueMinor} minor units of ${currency}.`);
    const stateError = await validateIncomingPaymentState(db, order, inferred, amountMinor);
    if (stateError) throw new ValidationError(stateError);
    paymentType = inferred;
    // Commands whose provider facts already landed (before this journal
    // converged, or by an invocation that died after its batch) no longer
    // hold the order.
    await convergePaymentCommands(db, { orderId: input.orderId });
  }

  const { gateway, providers, settings } = await commandGateway(db, input, method.providerId, "vault", "newPayment");
  if (capture === "manual" && !gatewayHasCapability(gateway, "manualCapture")) {
    throw new ValidationError(`${gateway.label} cannot authorize now and capture later.`);
  }
  if (!resuming) {
    const issue = providers.currencyIssue(gateway.id, currency)
      ?? getGatewayAmountIssue(gateway, amountMinor, currency)
      ?? providers.amountIssue(gateway.id, amountMinor, currency);
    if (issue) throw new ValidationError(issue);
  }
  const encoded = providers.encodeAmount(gateway.id, amountMinor, currency);
  const correlationId = buildPaymentCorrelationId(input.orderId, paymentType, attemptKey.slice(-8));

  const attempt = await claimAttempt(db, {
    attemptKey,
    requestHash,
    orderId: input.orderId,
    gateway: gateway.id,
    paymentType,
    amountMinor,
    currency,
    correlationId,
    // The order still reads as it did, holds no money in flight, and no
    // other command is open on it or calling its provider now (a deposit
    // and a full charge are different payment types, so the single-flight
    // index alone does not keep them apart).
    guard: resuming
      ? sql`1 = 1`
      : sql`EXISTS (
          SELECT 1 FROM ${orders}
          WHERE ${orders.id} = ${input.orderId}
            AND ${orders.version} = ${order.version}
            AND ${orders.deletedAt} IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${orderPayments}
          WHERE ${orderPayments.orderId} = ${input.orderId}
            AND ${orderPayments.status} IN (${PaymentRecordStatus.PENDING}, ${PaymentRecordStatus.CONFIRMED}, ${PaymentRecordStatus.AUTHORIZED})
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${paymentSessionAttempts}
          WHERE ${paymentSessionAttempts.orderId} = ${input.orderId}
            AND ${paymentSessionAttempts.attemptKey} <> ${attemptKey}
            AND (
              ${paymentSessionAttempts.status} IN (${sql.join(OPEN_COMMAND_STATUSES.map((status) => sql`${status}`), sql`, `)})
              OR (${paymentSessionAttempts.status} = 'processing' AND ${commandAttemptKeyCondition()})
            )
        )`,
    guardMessage: "This order changed, or another payment for it is still being settled. Read the order and try again.",
  });

  const base = { orderId: input.orderId, providerId: gateway.id, amountMinor, currency, declineReason: null, declineCode: null };
  let answer: Awaited<ReturnType<NonNullable<PaymentGateway["chargeSavedMethod"]>>>;
  try {
    answer = await withProviderDeadline((signal, requestTimeoutMs) => gateway.chargeSavedMethod!({
      attemptKey,
      correlationId,
      orderId: input.orderId,
      paymentType,
      amountMinor,
      currency,
      wireAmount: encoded.wire,
      methodRef: method.providerMethodRef,
      capture,
      requestTimeoutMs,
    }, { settings, signal }));
  } catch (error) {
    const failure = providerErrorOf(error);
    if (failure?.category === "declined" && !failure.uncertain) {
      const declined: StoredOutcome = { ...base, outcome: "declined", paymentId: null, providerRef: null, declineReason: failure.message, declineCode: failure.code };
      await finishAttempt(db, attempt, "created", { outcome: declined, error: failure.message });
      return { ...stripRef(declined), replayed: false };
    }
    return providerFailure(db, attempt, error, gateway.label);
  }

  if (answer.status === "declined") {
    const declined: StoredOutcome = { ...base, outcome: "declined", paymentId: null, providerRef: null, declineReason: answer.reason, declineCode: answer.code ?? null };
    await finishAttempt(db, attempt, "created", { outcome: declined, error: answer.reason });
    return { ...stripRef(declined), replayed: false };
  }
  if (answer.status === "pending") {
    // A repeat may already know the reference the first answer named.
    const providerRef = answer.providerRef ?? existing?.providerSessionId ?? null;
    const pending: StoredOutcome = { ...base, outcome: "pending", paymentId: null, providerRef };
    await finishAttempt(db, attempt, "pending", { outcome: pending, providerRef });
    // The provider's fact may have landed while this call was out.
    return settledAfterFinish(db, attemptKey, pending);
  }
  let applied: StoredOutcome;
  try {
    applied = await applyOutcome(db, input, { gateway, event: answer.event, orderId: input.orderId, source: "saved_method_charge", base });
  } catch (error) {
    // The provider answered but the event could not be applied: keep the
    // charge open (a repeat asks again and gets the same event).
    await finishAttempt(db, attempt, "uncertain", { providerRef: answer.event.providerRef, error: error instanceof Error ? error.message : "apply failed" });
    throw error;
  }
  await finishAttempt(db, attempt, applied.outcome === "pending" ? "pending" : "created", { outcome: applied, providerRef: answer.event.providerRef });
  return applied.outcome === "pending" ? settledAfterFinish(db, attemptKey, applied) : { ...stripRef(applied), replayed: false };
}

/** A command just recorded `pending`: settled at once when its fact landed meanwhile. */
async function settledAfterFinish(db: Database, attemptKey: string, pending: StoredOutcome): Promise<SavedMethodPaymentOutcome> {
  const row = await readAttempt(db, attemptKey);
  const settled = row ? await settleCommandFromLedger(db, row) : null;
  return { ...stripRef(settled ?? pending), replayed: false };
}

function stripRef(stored: StoredOutcome): Omit<SavedMethodPaymentOutcome, "replayed"> {
  const { providerRef: _providerRef, ...outcome } = stored;
  return outcome;
}

// ── Capture and void an authorization ───────────────────────────────────────

export interface AuthorizationCommandInput extends CommandDeps {
  /** The authorized `order_payments` row. */
  paymentId: string;
}

async function readAuthorization(db: Database, paymentId: string) {
  const row = await db.select({
    id: orderPayments.id,
    orderId: orderPayments.orderId,
    status: orderPayments.status,
    provider: orderPayments.paymentMethod,
    providerRef: orderPayments.providerRef,
    paymentType: orderPayments.paymentType,
    amountMinor: orderPayments.amountMinor,
    currency: orderPayments.currency,
  }).from(orderPayments).where(eq(orderPayments.id, paymentId)).get();
  if (!row || row.paymentType === "refund") throw new NotFoundError("Payment not found");
  return row;
}

/** A capture or void already decided by an earlier call (a `pending` one due another look asks again). */
async function settledAuthorization(
  db: Database,
  attemptKey: string,
): Promise<SavedMethodPaymentOutcome | null> {
  const attempt = await readAttempt(db, attemptKey);
  if (attempt) {
    const replayed = await replay(db, attempt);
    if (replayed && !replayed.recheck) return replayed.outcome;
    if (!replayed && isFreshProcessing(attempt)) throw inProgress();
  }
  return null;
}

/**
 * Capture an authorization in full: the provider's confirmed event goes
 * through the kernel (`processPaymentConfirmed`), which promotes the
 * authorized row to `succeeded` and credits the order (version CAS,
 * `payment.updated`, `order.paid` when nothing is left due).
 */
export async function captureAuthorizedPayment(db: Database, input: AuthorizationCommandInput): Promise<SavedMethodPaymentOutcome> {
  const row = await readAuthorization(db, input.paymentId);
  const attemptKey = `capture:${row.id}`;
  const settled = await settledAuthorization(db, attemptKey);
  if (settled) return settled;
  const base = { orderId: row.orderId, providerId: row.provider, amountMinor: row.amountMinor, currency: row.currency, declineReason: null, declineCode: null };
  if (row.status === PaymentRecordStatus.SUCCEEDED) return { ...base, outcome: "succeeded", paymentId: row.id, replayed: true };
  if (row.status !== PaymentRecordStatus.AUTHORIZED || !row.providerRef) {
    throw new ValidationError("Only an authorized payment can be captured.");
  }
  const { gateway, providers, settings } = await commandGateway(db, input, row.provider, "manualCapture", "existingPayment");
  const attempt = await claimAttempt(db, {
    attemptKey,
    requestHash: await sha256Hex(attemptKey),
    orderId: row.orderId,
    gateway: gateway.id,
    paymentType: row.paymentType as PaymentType,
    amountMinor: row.amountMinor,
    currency: row.currency,
    correlationId: buildPaymentCorrelationId(row.orderId, row.paymentType as PaymentType, row.id.replace(/-/g, "").slice(-8)),
    guard: sql`EXISTS (SELECT 1 FROM ${orderPayments} WHERE ${orderPayments.id} = ${row.id} AND ${orderPayments.status} = ${PaymentRecordStatus.AUTHORIZED})`,
    guardMessage: "This authorization was captured or released meanwhile.",
  });
  let answer: Awaited<ReturnType<NonNullable<PaymentGateway["capture"]>>>;
  try {
    answer = await withProviderDeadline((signal) => gateway.capture!({
      providerRef: row.providerRef!,
      orderId: row.orderId,
      amountMinor: row.amountMinor,
      currency: row.currency,
      wireAmount: providers.encodeAmount(gateway.id, row.amountMinor, row.currency).wire,
      idempotencyKey: attemptKey,
    }, { settings, signal }));
  } catch (error) {
    const failure = providerErrorOf(error);
    if (failure?.category === "declined" && !failure.uncertain) {
      const declined: StoredOutcome = { ...base, outcome: "declined", paymentId: row.id, providerRef: row.providerRef, declineReason: failure.message, declineCode: failure.code };
      await finishAttempt(db, attempt, "failed", { outcome: declined, error: failure.message });
      return { ...stripRef(declined), replayed: false };
    }
    return providerFailure(db, attempt, error, gateway.label);
  }
  if (answer.status === "declined") {
    // The hold could not be captured now (expired, released): nothing changed; a later capture may ask again.
    await finishAttempt(db, attempt, "failed", { error: answer.reason });
    return { ...base, outcome: "declined", paymentId: row.id, declineReason: answer.reason, declineCode: answer.code ?? null, replayed: false };
  }
  if (answer.status === "pending") {
    const pending: StoredOutcome = { ...base, outcome: "pending", paymentId: row.id, providerRef: row.providerRef };
    await finishAttempt(db, attempt, "pending", { outcome: pending, providerRef: row.providerRef });
    return settledAfterFinish(db, attemptKey, pending);
  }
  if (answer.event.providerRef !== row.providerRef) {
    await finishAttempt(db, attempt, "uncertain", { error: "capture answered another payment reference" });
    throw new AppError(503, "provider_invalid_response", `${gateway.label} answered the capture for another payment.`);
  }
  let applied: StoredOutcome;
  try {
    applied = await applyOutcome(db, input, { gateway, event: answer.event, orderId: row.orderId, source: "authorization_capture", base: { ...base, amountMinor: answer.event.amountMinor ?? row.amountMinor } });
  } catch (error) {
    await finishAttempt(db, attempt, "uncertain", { error: error instanceof Error ? error.message : "apply failed" });
    throw error;
  }
  // Still authorized: the kernel refused the capture (manual reconciliation) or will retry it.
  const outcome = applied.outcome === "authorized" ? { ...applied, outcome: "pending" as const } : applied;
  await finishAttempt(db, attempt, outcome.outcome === "succeeded" ? "created" : "pending", { outcome, providerRef: row.providerRef });
  return outcome.outcome === "succeeded" ? { ...stripRef(outcome), replayed: false } : settledAfterFinish(db, attemptKey, outcome);
}

/**
 * Void an authorization: the provider releases the hold, then the row is
 * marked `cancelled` (`payment.updated`). The order keeps its state, unpaid;
 * staff may cancel it or charge again.
 */
export async function voidAuthorizedPayment(db: Database, input: AuthorizationCommandInput): Promise<SavedMethodPaymentOutcome> {
  const row = await readAuthorization(db, input.paymentId);
  const attemptKey = `void:${row.id}`;
  const settled = await settledAuthorization(db, attemptKey);
  if (settled) return settled;
  const base = { orderId: row.orderId, providerId: row.provider, amountMinor: row.amountMinor, currency: row.currency, declineReason: null, declineCode: null };
  if (row.status === PaymentRecordStatus.CANCELLED) return { ...base, outcome: "voided", paymentId: row.id, replayed: true };
  if (row.status !== PaymentRecordStatus.AUTHORIZED || !row.providerRef) {
    throw new ValidationError("Only an authorized payment can be voided; refund a captured one.");
  }
  const { gateway, settings } = await commandGateway(db, input, row.provider, "manualCapture", "existingPayment");
  const attempt = await claimAttempt(db, {
    attemptKey,
    requestHash: await sha256Hex(attemptKey),
    orderId: row.orderId,
    gateway: gateway.id,
    paymentType: row.paymentType as PaymentType,
    amountMinor: row.amountMinor,
    currency: row.currency,
    correlationId: buildPaymentCorrelationId(row.orderId, row.paymentType as PaymentType, row.id.replace(/-/g, "").slice(0, 8)),
    guard: sql`EXISTS (SELECT 1 FROM ${orderPayments} WHERE ${orderPayments.id} = ${row.id} AND ${orderPayments.status} = ${PaymentRecordStatus.AUTHORIZED})`,
    guardMessage: "This authorization was captured or released meanwhile.",
  });
  let answer: Awaited<ReturnType<NonNullable<PaymentGateway["void"]>>>;
  try {
    answer = await withProviderDeadline((signal) => gateway.void!({ providerRef: row.providerRef!, orderId: row.orderId, idempotencyKey: attemptKey }, { settings, signal }));
  } catch (error) {
    const failure = providerErrorOf(error);
    if (failure?.category === "declined" && !failure.uncertain) {
      await finishAttempt(db, attempt, "failed", { error: failure.message });
      return { ...base, outcome: "declined", paymentId: row.id, declineReason: failure.message, declineCode: failure.code, replayed: false };
    }
    return providerFailure(db, attempt, error, gateway.label);
  }
  if (answer.status === "declined") {
    await finishAttempt(db, attempt, "failed", { error: answer.reason });
    return { ...base, outcome: "declined", paymentId: row.id, declineReason: answer.reason, declineCode: answer.code ?? null, replayed: false };
  }
  if (answer.status === "pending") {
    // The provider's cancelled event releases the row (processPaymentFailed) and settles this void.
    const pending: StoredOutcome = { ...base, outcome: "pending", paymentId: row.id, providerRef: row.providerRef };
    await finishAttempt(db, attempt, "pending", { outcome: pending, providerRef: row.providerRef });
    return settledAfterFinish(db, attemptKey, pending);
  }
  await releaseAuthorization(db, { orderId: row.orderId, provider: row.provider, providerRef: row.providerRef });
  const voided: StoredOutcome = { ...base, outcome: "voided", paymentId: row.id, providerRef: row.providerRef };
  await finishAttempt(db, attempt, "created", { outcome: voided, providerRef: row.providerRef });
  // A capture still pending on the released hold is over too.
  await convergePaymentCommandsAfterFact(db, { orderId: row.orderId, provider: row.provider, providerRef: row.providerRef });
  return { ...stripRef(voided), replayed: false };
}

// ── The sweep: open commands nothing settled ────────────────────────────────

/**
 * Each due state of an open command, one index range of `(status,
 * claim_expires_at)`: past its next look, recorded before it had one (null),
 * or `processing` past its lease (the invocation calling the provider died).
 */
function dueCommandBranches() {
  return [
    ...OPEN_COMMAND_STATUSES.flatMap((status) => [
      and(eq(paymentSessionAttempts.status, status), lte(paymentSessionAttempts.claimExpiresAt, sql`unixepoch()`))!,
      and(eq(paymentSessionAttempts.status, status), isNull(paymentSessionAttempts.claimExpiresAt))!,
    ]),
    and(eq(paymentSessionAttempts.status, "processing"), lte(paymentSessionAttempts.claimExpiresAt, sql`unixepoch()`), commandAttemptKeyCondition())!,
  ];
}

/**
 * A command whose invocation died while calling its provider: it may have
 * reached the provider, so it is `uncertain` (a repeat asks again under the
 * same key; the order takes no other charge meanwhile). Null when it is not
 * such a row any more.
 */
async function abandonedToUncertain(db: Database, row: AttemptRow): Promise<AttemptRow | null> {
  if (row.status !== "processing" || isFreshProcessing(row)) return null;
  const [moved] = await db.update(paymentSessionAttempts).set({
    status: "uncertain",
    claimId: null,
    claimExpiresAt: sql`unixepoch()`,
    lastError: "The request ended before the provider answered.",
    updatedAt: sql`unixepoch()`,
  }).where(and(
    eq(paymentSessionAttempts.id, row.id),
    eq(paymentSessionAttempts.status, "processing"),
    lte(paymentSessionAttempts.claimExpiresAt, sql`unixepoch()`),
  )).returning();
  return moved ?? null;
}

/** Whether the sweep has an open command to look at: one bounded index probe per due state. */
export function duePaymentCommandProbes(db: Database) {
  return dueCommandBranches().map((branch) =>
    db.select({ id: paymentSessionAttempts.id }).from(paymentSessionAttempts).where(branch).limit(1));
}

/** Open commands due a look, oldest first. */
export async function listDuePaymentCommands(db: Database, limit: number): Promise<string[]> {
  const rows = await db.select({ id: paymentSessionAttempts.id })
    .from(paymentSessionAttempts)
    .where(or(...dueCommandBranches()))
    .orderBy(paymentSessionAttempts.updatedAt)
    .limit(Math.max(1, Math.min(limit, 100)))
    .all();
  return rows.map((row) => row.id);
}

export type PaymentCommandSweepOutcome = "settled" | "expired" | "open" | "skipped";

/**
 * One open command's look: settled from the ledger when its fact landed;
 * else, with a provider reference, the gateway's status lookup
 * (`queryPayment`) applies a captured payment through the kernel; past
 * `COMMAND_EXPIRY_SECONDS` since it was last answered it is expired (below);
 * otherwise it is looked at again later. Never calls a command again: a
 * charge, capture or void is sent only by its caller's request.
 */
export async function reconcilePaymentCommand(db: Database, deps: PaymentCommandDeps, attemptId: string): Promise<PaymentCommandSweepOutcome> {
  const found = await db.select().from(paymentSessionAttempts).where(eq(paymentSessionAttempts.id, attemptId)).get();
  if (!found || !commandKindOf(found.attemptKey)) return "skipped";
  const row = found.status === "processing" ? await abandonedToUncertain(db, found) : found;
  if (!row || !isOpenCommandStatus(row.status) || !commandDue(row)) return "skipped";
  if (await settleCommandFromLedger(db, row)) return "settled";

  if (row.providerSessionId && await lookUpCommandPayment(db, deps, row)) {
    const current = await db.select().from(paymentSessionAttempts).where(eq(paymentSessionAttempts.id, row.id)).get();
    if (!current || !isOpenCommandStatus(current.status) || await settleCommandFromLedger(db, current)) return "settled";
  }

  const now = nowSeconds();
  const age = now - Number(row.updatedAt);
  if (age >= COMMAND_EXPIRY_SECONDS) return (await expireCommand(db, row)) ? "expired" : "skipped";
  const delay = Math.min(SWEEP_MAX_DELAY_SECONDS, Math.max(SWEEP_MIN_DELAY_SECONDS, Math.floor(age / 2)));
  await db.update(paymentSessionAttempts)
    .set({ claimExpiresAt: sql`unixepoch() + ${delay}` })
    .where(and(eq(paymentSessionAttempts.id, row.id), inArray(paymentSessionAttempts.status, [...OPEN_COMMAND_STATUSES])));
  return "open";
}

/** Ask the gateway whether the command's payment was captured, and apply it once if so. True when a fact was applied. */
async function lookUpCommandPayment(db: Database, deps: PaymentCommandDeps, row: AttemptRow): Promise<boolean> {
  try {
    const gateway = (await paymentProvidersFor(deps.providers, row.gateway)).get(row.gateway);
    if (!gateway?.queryPayment) return false;
    const settings = await gateway.loadSettings(db, deps.encryptionKey);
    if (!canOperateExistingPayments(gateway, settings)) return false;
    const query = await withProviderDeadline((signal, requestTimeoutMs) => gateway.queryPayment!(
      { providerRef: row.providerSessionId!, orderId: row.orderId, requestTimeoutMs },
      { settings, signal },
    ));
    const event = query.event;
    if (!event || event.kind !== "confirmed" || event.orderId !== row.orderId || event.providerRef !== row.providerSessionId) return false;
    await deps.applyEvent({ provider: gateway.id, event, source: "payment_command_reconciliation" });
    return true;
  } catch (error) {
    console.warn(`[payments] Looking up the ${row.gateway} payment of an open command failed; the sweep asks again:`, error instanceof Error ? error.name : "error");
    return false;
  }
}

/**
 * Expire a command nothing settled within `COMMAND_EXPIRY_SECONDS`. A
 * capture or a void is `failed`: the authorization is still held (the
 * ledger keeps it guarded) and the same request may ask again. A charge is
 * declined `payment_expired` and its order takes charges again, unless a
 * payment of the same gateway, kind and amount landed on the order since it
 * was sent (its fact named no reference this journal knew): then it closes
 * as that payment. A fact arriving later is still applied once by the
 * kernel; one the order no longer owes goes to manual reconciliation, never
 * a second credit.
 */
async function expireCommand(db: Database, row: AttemptRow): Promise<boolean> {
  const kind = commandKindOf(row.attemptKey)!;
  if (kind !== "charge") {
    return closeCommandAttempt(db, row, "failed", { error: "The provider did not settle this request within three days; send it again to ask." });
  }
  const landed = await db.select({ id: orderPayments.id, status: orderPayments.status, providerRef: orderPayments.providerRef })
    .from(orderPayments)
    .where(and(
      eq(orderPayments.orderId, row.orderId),
      eq(orderPayments.paymentMethod, row.gateway),
      eq(orderPayments.paymentType, row.paymentType),
      eq(orderPayments.amountMinor, row.amountMinor),
      inArray(orderPayments.status, [PaymentRecordStatus.SUCCEEDED, PaymentRecordStatus.REFUNDED, PaymentRecordStatus.AUTHORIZED]),
      sql`${orderPayments.createdAt} >= ${Number(row.createdAt)}`,
    ))
    .get();
  const verdict = landed ? commandOutcomeFromLedger("charge", landed.status) : null;
  const outcome = verdict && landed
    ? commandOutcomeOf(row, verdict, landed, landed.providerRef)
    : commandOutcomeOf(row, {
      outcome: "declined",
      declineReason: "The provider did not settle this payment within three days; nothing was credited. Read the order before charging again.",
      declineCode: "payment_expired",
    }, null, row.providerSessionId);
  return closeCommandAttempt(db, row, "created", { outcome, error: outcome.declineReason });
}
