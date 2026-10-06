// Payments: one bKash payment per Scalius attempt (createSession), finished
// on the buyer's return (verifyReturn) and asked about later (queryPayment).
//
// bKash Tokenized Checkout charges nothing until the merchant calls Execute,
// so a payment completes only through this app's own server-to-server call
// for a paymentID it created. A return's query parameters are never trusted:
// they name the payment to ask bKash about, and bKash's answer is the fact.
// A payment this app reported cancelled or failed is closed: no later return
// executes it, so the attempt the platform released stays released.

import {
  ProviderError,
  type PaymentEvent,
  type PaymentQuery,
  type PaymentQueryInput,
  type PaymentSession,
  type PaymentSessionInput,
  type PaymentVerification,
  type PluginContext,
  type PluginStorageCollection,
  type ProviderHttpRequest,
} from "@scalius/plugin-sdk";
import {
  BKASH_ID,
  createBkashClient,
  field,
  isCompleted,
  paymentStatus,
  rejectionError,
  takaToMinor,
  type BkashAnswer,
  type BkashClient,
} from "./client";
import { sha256Hex } from "./hash";

type UnpaidKind = "cancelled" | "failed";
type ReturnStatus = "success" | "failure" | "cancel";

/** One bKash payment this app created (record id: bKash's paymentID): what returns and queries are checked against. */
export interface PaymentRecord extends Record<string, unknown> {
  /** SHA-256 of the platform's attempt key: a retried createSession finds its payment by it. */
  attemptHash: string;
  orderId: string;
  /** Sent to bKash as merchantInvoiceNumber, which bKash echoes on every answer. */
  correlationId: string;
  paymentType: PaymentSessionInput["paymentType"];
  amountMinor: number;
  currency: string;
  redirectUrl: string;
  /** Set once the app reported the payment cancelled or failed; it is never executed after that. */
  closedAs: UnpaidKind | null;
}

/** A payment this app created, with what an operation needs to settle it. */
interface KnownPayment {
  ctx: PluginContext;
  client: BkashClient;
  paymentId: string;
  record: PaymentRecord;
}

/** The `eventType` of every bKash fact. `eventId` is the capture's trxID, or `<paymentID>:<kind>`. */
const EVENT_TYPE = "bkash.payment";
/** A return may grant a token, Execute and Query: its share of the app's 30 s wall time. */
const RETURN_BUDGET_MS = 25_000;

function payments(ctx: PluginContext): PluginStorageCollection<PaymentRecord> {
  return ctx.storage.payments as PluginStorageCollection<PaymentRecord>;
}

/** bKash pre-fills the wallet number from payerReference: the buyer's mobile number as 01XXXXXXXXX, else a blank. */
function payerReferenceOf(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  const local = digits.startsWith("880") ? digits.slice(2) : digits;
  return /^01[3-9]\d{8}$/.test(local) ? local : " ";
}

function isPaymentPage(url: string): boolean {
  return url.startsWith("https://") && url.length <= 2048 && URL.canParse(url);
}

function returnStatusOf(value: string | undefined): ReturnStatus | null {
  return value === "success" || value === "failure" || value === "cancel" ? value : null;
}

// ── createSession ───────────────────────────────────────────────────────────

export async function createSession(input: PaymentSessionInput, ctx: PluginContext): Promise<PaymentSession> {
  if (input.currency !== "BDT") throw new ProviderError("declined", "bKash charges only BDT.", { code: "bkash.currency" });
  const attemptHash = await sha256Hex(input.attemptKey);
  const { records } = await payments(ctx).query({ where: { attemptHash }, limit: 1 });
  const existing = records[0];
  // A retry of the same attempt gets the same bKash payment, never a second one.
  if (existing) return { providerRef: existing.id, redirectUrl: existing.data.redirectUrl };

  const client = createBkashClient(ctx, input.requestTimeoutMs);
  const reply = await client.post("create", {
    mode: "0011",
    payerReference: input.buyer.phone ? payerReferenceOf(input.buyer.phone) : " ",
    // bKash sends the buyer back here with paymentID and status appended, whatever the outcome.
    callbackURL: input.urls.success,
    amount: input.wireAmount.decimal,
    currency: input.currency,
    intent: "sale",
    merchantInvoiceNumber: input.correlationId,
  }, { mutating: true });
  if (!reply.ok) throw rejectionError(reply.rejection, "bKash did not start the payment", { mutating: true });

  const paymentId = field(reply.answer, "paymentID");
  const redirectUrl = field(reply.answer, "bkashURL");
  if (!BKASH_ID.test(paymentId) || !isPaymentPage(redirectUrl)) {
    throw new ProviderError("retryable", "bKash's answer did not include its payment page.", { uncertain: true, code: "bkash.unreadable" });
  }
  await payments(ctx).put(paymentId, {
    attemptHash,
    orderId: input.orderId,
    correlationId: input.correlationId,
    paymentType: input.paymentType,
    amountMinor: input.amountMinor,
    currency: input.currency,
    redirectUrl,
    closedAs: null,
  });
  ctx.log.info("bKash payment created", { paymentId, orderId: input.orderId });
  return { providerRef: paymentId, redirectUrl };
}

// ── verifyReturn ────────────────────────────────────────────────────────────

export async function verifyReturn(request: ProviderHttpRequest, ctx: PluginContext): Promise<PaymentVerification> {
  const paymentId = request.query.paymentID ?? "";
  const status = returnStatusOf(request.query.status);
  if (!BKASH_ID.test(paymentId) || !status) {
    return { status: "invalid", reason: "The return does not name a bKash payment and its outcome." };
  }
  const record = await payments(ctx).get(paymentId);
  if (!record) return { status: "invalid", reason: "The return names a bKash payment this store did not create." };

  const payment: KnownPayment = { ctx, client: createBkashClient(ctx, RETURN_BUDGET_MS), paymentId, record };
  try {
    if (status === "success" && record.closedAs === null) return await executeReturn(payment);
    return await settleUnpaid(payment, record.closedAs ?? (status === "cancel" ? "cancelled" : "failed"));
  } catch (error) {
    if (!(error instanceof ProviderError) || error.category === "misconfigured") throw error;
    // bKash could not be asked (retry), or does not know the payment (invalid): never a guess.
    return error.category === "retryable" ? { status: "retry", reason: error.message } : { status: "invalid", reason: error.message };
  }
}

/**
 * A success return. Execute completes the payment; when bKash refuses (an
 * earlier return already executed it, the buyer never authorised it, or
 * bKash declined it) the payment's status decides.
 */
async function executeReturn(payment: KnownPayment): Promise<PaymentVerification> {
  const executed = await payment.client.post("execute", { paymentID: payment.paymentId }, { mutating: true });
  if (executed.ok && isCompleted(executed.answer)) return confirmed(payment, executed.answer);

  const answer = await paymentStatus(payment.client, payment.paymentId);
  if (isCompleted(answer)) return confirmed(payment, answer);
  if (!executed.ok && !executed.rejection.transient) return close(payment, "failed", answer);
  // bKash was busy, or took the execution without completing it: the payment may still complete.
  return { status: "retry", reason: "bKash has not completed this payment yet." };
}

/** A cancel or failure return, or any return of a closed payment: unless bKash reports it completed, it is released. */
async function settleUnpaid(payment: KnownPayment, kind: UnpaidKind): Promise<PaymentVerification> {
  const answer = await paymentStatus(payment.client, payment.paymentId);
  if (isCompleted(answer)) return confirmed(payment, answer);
  return close(payment, kind, answer);
}

function confirmed(payment: KnownPayment, answer: BkashAnswer): PaymentVerification {
  const mismatch = mismatchOf(payment, answer);
  return mismatch ? { status: "invalid", reason: mismatch } : { status: "event", event: confirmedEvent(payment, answer) };
}

/** Reports the payment cancelled or failed, and closes it so that no later return executes it. */
async function close(payment: KnownPayment, kind: UnpaidKind, answer: BkashAnswer): Promise<PaymentVerification> {
  const mismatch = mismatchOf(payment, answer);
  if (mismatch) return { status: "invalid", reason: mismatch };
  const { ctx, client, paymentId, record } = payment;
  if (record.closedAs === null) await payments(ctx).put(paymentId, { ...record, closedAs: kind });
  return {
    status: "event",
    event: {
      kind,
      eventType: EVENT_TYPE,
      eventId: `${paymentId}:${kind}`,
      orderId: record.orderId,
      providerRef: paymentId,
      // The merchantInvoiceNumber bKash holds for this paymentID: the attempt the platform releases.
      correlationId: record.correlationId,
      details: { environment: client.environment, transactionStatus: field(answer, "transactionStatus").slice(0, 100) || null },
    },
  };
}

// ── queryPayment ────────────────────────────────────────────────────────────

export async function queryPayment(input: PaymentQueryInput, ctx: PluginContext): Promise<PaymentQuery> {
  const record = await payments(ctx).get(input.providerRef);
  if (!record || record.orderId !== input.orderId) {
    throw new ProviderError("declined", "This bKash payment was not created for this order.", { code: "bkash.unknown_payment" });
  }
  const payment: KnownPayment = { ctx, client: createBkashClient(ctx, input.requestTimeoutMs), paymentId: input.providerRef, record };
  const answer = await paymentStatus(payment.client, payment.paymentId);
  const providerStatus = (field(answer, "transactionStatus") || "Unknown").slice(0, 100);
  if (!isCompleted(answer)) return { providerStatus };
  const mismatch = mismatchOf(payment, answer);
  if (mismatch) throw new ProviderError("declined", mismatch, { code: "bkash.mismatch" });
  return { providerStatus, event: confirmedEvent(payment, answer) };
}

// ── Checking bKash's answers ────────────────────────────────────────────────

/**
 * Why bKash's answer cannot settle this payment, or null when it can: it
 * names another payment or invoice, or (completed) its capture differs from
 * what this app asked bKash to charge. Logged, as it should never happen.
 */
function mismatchOf(payment: KnownPayment, answer: BkashAnswer): string | null {
  const reason = answerMismatch(payment, answer);
  if (reason) payment.ctx.log.error(reason, { paymentId: payment.paymentId });
  return reason;
}

function answerMismatch({ paymentId, record }: KnownPayment, answer: BkashAnswer): string | null {
  const answeredId = field(answer, "paymentID");
  const invoice = field(answer, "merchantInvoiceNumber");
  if ((answeredId && answeredId !== paymentId) || (invoice && invoice !== record.correlationId)) {
    return "bKash answered for another payment than the one it was asked about.";
  }
  if (!isCompleted(answer)) return null;
  if (!BKASH_ID.test(field(answer, "trxID"))) return "bKash reported the payment completed without a transaction id.";
  if (field(answer, "currency") !== record.currency) return "bKash reports another currency than this payment's.";
  if (takaToMinor(field(answer, "amount")) !== record.amountMinor) return "bKash reports another amount than this payment's.";
  return null;
}

/** A checked completed answer as the confirmed event. The same capture gives the same event however it was reached. */
function confirmedEvent({ client, paymentId, record }: KnownPayment, answer: BkashAnswer): PaymentEvent {
  const trxId = field(answer, "trxID");
  return {
    kind: "confirmed",
    eventType: EVENT_TYPE,
    eventId: trxId,
    orderId: record.orderId,
    providerRef: paymentId,
    secondaryRef: trxId,
    amountMinor: record.amountMinor,
    currency: record.currency,
    paymentType: record.paymentType,
    details: { environment: client.environment },
  };
}
