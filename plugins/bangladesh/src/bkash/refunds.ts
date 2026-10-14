// Refunds: bKash's refund API, applied at most once per Scalius refund
// allocation. bKash's refund call has no idempotency key of its own, so each
// refund is recorded under the platform's key before it is sent: a replay
// returns the recorded result or asks bKash (never sending twice), and an
// answer lost in transit is settled by refundStatus. A refund bKash refused,
// or one that never left, leaves no record: nothing moved, so it may be sent
// again.

import {
  ProviderError,
  type PaymentRefund,
  type PaymentRefundInput,
  type PaymentRefundProbe,
  type PaymentRefundProbeInput,
  type PluginContext,
  type PluginStorageCollection,
} from "@scalius/plugin-sdk";
import {
  BKASH_ID,
  createBkashClient,
  field,
  isCompleted,
  paymentStatus,
  platformErrorCode,
  rejectionError,
  takaToMinor,
  type BkashAnswer,
  type BkashClient,
  type BkashReply,
} from "./client";
import { sha256Hex } from "./hash";

/** One refund sent to bKash (record id: SHA-256 of the platform's idempotency key). */
export interface RefundRecord extends Record<string, unknown> {
  paymentId: string;
  /** The captured transaction refunded (bKash's trxID). */
  trxId: string;
  amountMinor: number;
  /** "sent": the request left and its outcome may be unknown. "completed": bKash reported it completed. */
  state: "sent" | "completed";
  /** bKash's refundTrxID, once known. Unique, so one bKash refund settles one Scalius refund. */
  refundTrxId: string | null;
}

/** A refund as bKash reports it (the refund call's answer, or its status). */
interface ReportedRefund {
  refundTrxId: string;
  originalTrxId: string;
  amountMinor: number | null;
  status: string;
}

/** A refund or its probe makes at most a grant, a status query and the refund call. */
const REFUND_BUDGET_MS = 25_000;
/** bKash's statuses for a refund that did not happen. */
const REFUND_FAILED = new Set(["Failed", "Declined", "Cancelled"]);

function refunds(ctx: PluginContext): PluginStorageCollection<RefundRecord> {
  return ctx.storage["bkash-refunds"] as PluginStorageCollection<RefundRecord>;
}

/** Idempotency keys may be 256 characters; record ids at most 128. */
const recordIdOf = (idempotencyKey: string) => sha256Hex(idempotencyKey);

function reportedRefund(answer: BkashAnswer): ReportedRefund {
  const refundTrxId = field(answer, "refundTrxID");
  return {
    refundTrxId: BKASH_ID.test(refundTrxId) ? refundTrxId : "",
    originalTrxId: field(answer, "originalTrxID"),
    amountMinor: takaToMinor(field(answer, "amount")),
    status: field(answer, "transactionStatus").slice(0, 100),
  };
}

// ── refund ──────────────────────────────────────────────────────────────────

export async function refund(input: PaymentRefundInput, ctx: PluginContext): Promise<PaymentRefund> {
  if (input.currency !== "BDT") throw new ProviderError("declined", "bKash refunds only BDT.", { code: "bkash.currency" });
  const id = await recordIdOf(input.idempotencyKey);
  const stored = await refunds(ctx).get(id);
  if (stored?.state === "completed" && stored.refundTrxId) return { refundId: stored.refundTrxId };

  const client = createBkashClient(ctx, REFUND_BUDGET_MS);
  if (stored) return settleReplay(ctx, client, id, stored);

  const trxId = input.secondaryRef ?? await capturedTrxId(client, input.providerRef);
  const record: RefundRecord = { paymentId: input.providerRef, trxId, amountMinor: input.amountMinor, state: "sent", refundTrxId: null };
  // Recorded before it is sent: whatever happens next, this key never sends a second refund.
  await refunds(ctx).put(id, record);
  const answer = await sendRefund(ctx, client, id, {
    paymentID: input.providerRef,
    amount: input.wireAmount.decimal,
    trxID: trxId,
    sku: input.reference,
    reason: input.reason.trim().slice(0, 255) || "Refund",
  });

  const reported = reportedRefund(answer);
  if (isCompleted(answer) && reported.refundTrxId && reported.amountMinor === input.amountMinor) {
    await refunds(ctx).put(id, { ...record, state: "completed", refundTrxId: reported.refundTrxId });
    ctx.log.info("bKash refund completed", { paymentId: input.providerRef, refundTrxId: reported.refundTrxId });
    return { refundId: reported.refundTrxId };
  }
  // bKash took it without reporting it completed (or for another amount): refundStatus settles it.
  if (reported.refundTrxId) await refunds(ctx).put(id, { ...record, refundTrxId: reported.refundTrxId });
  throw new ProviderError("retryable", "bKash has not reported the refund completed yet.", { uncertain: true, code: "bkash.refund_pending" });
}

/**
 * Sends the refund. When it certainly did not happen (bKash refused it, or
 * the request never left) the record is removed and the error raised; only
 * an uncertain failure keeps it, for refundStatus to settle.
 */
async function sendRefund(ctx: PluginContext, client: BkashClient, id: string, body: Record<string, string>): Promise<BkashAnswer> {
  let reply: BkashReply;
  try {
    reply = await client.post("payment/refund", body, { mutating: true });
  } catch (error) {
    if (!(error instanceof ProviderError && error.uncertain)) await refunds(ctx).delete(id);
    throw error;
  }
  if (reply.ok) return reply.answer;
  const error = rejectionError(reply.rejection, "bKash refused the refund", { mutating: true });
  if (!error.uncertain) await refunds(ctx).delete(id);
  throw error;
}

/** The same refund asked for again while its outcome is open: bKash is asked, the refund is never sent twice. */
async function settleReplay(ctx: PluginContext, client: BkashClient, id: string, stored: RefundRecord): Promise<PaymentRefund> {
  const probe = await probeRefund(ctx, client, id, stored);
  if (probe.outcome === "accepted" && probe.providerRefundId) return { refundId: probe.providerRefundId };
  if (probe.outcome === "rejected") throw new ProviderError("declined", "bKash reports this refund failed.", { code: "bkash.refund_failed" });
  throw new ProviderError("retryable", "This refund was already sent to bKash; its outcome is not known yet.", { uncertain: true, code: "bkash.refund_pending" });
}

/** The captured transaction of a payment when the platform has none on record: bKash's status names it. */
async function capturedTrxId(client: BkashClient, paymentId: string): Promise<string> {
  const answer = await paymentStatus(client, paymentId);
  const trxId = field(answer, "trxID");
  if (!isCompleted(answer) || !BKASH_ID.test(trxId)) {
    throw new ProviderError("declined", "bKash has no completed payment to refund.", { code: "bkash.not_completed" });
  }
  return trxId;
}

// ── refundStatus ────────────────────────────────────────────────────────────

export async function refundStatus(input: PaymentRefundProbeInput, ctx: PluginContext): Promise<PaymentRefundProbe> {
  const id = await recordIdOf(input.idempotencyKey);
  const record = await refunds(ctx).get(id);
  if (!record) return { outcome: "unknown", manualReview: true, error: "This app has no record of sending this refund to bKash." };
  if (record.state === "completed" && record.refundTrxId) {
    return { outcome: "accepted", providerRefundId: record.refundTrxId, providerStatus: "Completed" };
  }
  try {
    return await probeRefund(ctx, createBkashClient(ctx, REFUND_BUDGET_MS), id, record);
  } catch (error) {
    // bKash could not be asked, or the credentials need fixing: ask again later.
    if (error instanceof ProviderError) return { outcome: "unknown", error: error.message };
    throw error;
  }
}

/**
 * Asks bKash about a sent refund (the refund call with the payment and its
 * transaction, and no amount) and settles the record when bKash's answer is
 * this refund: the refundTrxID bKash gave, when one was received, else the
 * refund of this amount on the transaction that no other refund has claimed.
 */
async function probeRefund(ctx: PluginContext, client: BkashClient, id: string, record: RefundRecord): Promise<PaymentRefundProbe> {
  const reply = await client.post("payment/refund", { paymentID: record.paymentId, trxID: record.trxId }, { mutating: false });
  if (!reply.ok) {
    const error = rejectionError(reply.rejection, "bKash could not report the refund", { mutating: false }).message;
    return { outcome: "unknown", error, manualReview: !reply.rejection.transient };
  }
  const reported = reportedRefund(reply.answer);
  if (!isThisRefund(record, reported)) {
    return { outcome: "unknown", manualReview: true, error: "bKash reports no refund matching this one; check the payment in the bKash merchant portal." };
  }
  const providerRefundId = reported.refundTrxId;
  if (reported.amountMinor !== record.amountMinor) {
    return { outcome: "unknown", providerRefundId, manualReview: true, error: "bKash reports this refund for another amount." };
  }
  if (isCompleted(reply.answer)) return claim(ctx, id, record, reported);
  if (REFUND_FAILED.has(reported.status)) {
    // Final only for the refund bKash named as this one; a match by amount alone may be another attempt's.
    return record.refundTrxId
      ? { outcome: "rejected", providerRefundId, providerStatus: reported.status }
      : { outcome: "unknown", providerRefundId, providerStatus: reported.status, manualReview: true, error: "bKash reports a failed refund of this amount; check it in the bKash merchant portal." };
  }
  return { outcome: "processing", providerRefundId, providerStatus: reported.status || "Processing" };
}

function isThisRefund(record: RefundRecord, reported: ReportedRefund): boolean {
  if (!reported.refundTrxId) return false;
  if (reported.originalTrxId && reported.originalTrxId !== record.trxId) return false;
  return record.refundTrxId ? reported.refundTrxId === record.refundTrxId : reported.amountMinor === record.amountMinor;
}

/** Records bKash's refund as this one's. The unique refundTrxId refuses a refund another one already claimed. */
async function claim(ctx: PluginContext, id: string, record: RefundRecord, reported: ReportedRefund): Promise<PaymentRefundProbe> {
  try {
    await refunds(ctx).put(id, { ...record, state: "completed", refundTrxId: reported.refundTrxId });
  } catch (error) {
    if (platformErrorCode(error) !== "storage.unique_violation") throw error;
    return { outcome: "unknown", providerRefundId: reported.refundTrxId, manualReview: true, error: "This bKash refund already settles another refund; check the payment in the bKash merchant portal." };
  }
  return { outcome: "accepted", providerRefundId: reported.refundTrxId, providerStatus: reported.status };
}
