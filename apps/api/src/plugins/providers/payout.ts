// Sending a payout through an app payout provider (the `payout` port), for
// `payouts.create` (routes/admin/resources-payouts.ts). In this order:
//
//   1. a repeat of a key whose payout is already answered (processing, paid,
//      failed) is answered from the record, without the provider;
//   2. the provider must be an installed, active, configured payout provider,
//      or nothing is written (422 `payout_provider_unavailable`);
//   3. the payout is committed `pending` (core `recordPayout`);
//   4. the provider is called with `payoutId` = the payout's id, the same on
//      every retry (the port requires a provider to apply a payout once per
//      `payoutId`); a resubmit asks `payoutStatus` first;
//   5. its answer is applied forward only.
//
// A `declined` or `misconfigured` ProviderError ends the payout `failed`
// with its code. Anything else (`retryable`, uncertain or not, a timeout, an
// answer outside the port) leaves it `pending`: the outcome is unknown, and
// the same request resubmits it.
import type { Database } from "@scalius/database/client";
import type { BoundProvider } from "@scalius/core/integrations/provider-port";
import {
  applyPayoutAnswer,
  applyPayoutReversalAnswer,
  findPayoutByKey,
  findPayoutReversalByKey,
  getAppPayout,
  recordPayout,
  recordPayoutReversal,
  type Payout,
  type PayoutAnswer,
  type PayoutRequest,
  type PayoutReversal,
  type PayoutReversalAnswer,
  type PayoutReversalRequest,
} from "@scalius/core/modules/payouts";
import {
  isQualifiedProviderId,
  payoutResultSchema,
  payoutReversalResultSchema,
  payoutReversalStatusSchema,
  payoutStatusSchema,
  providerErrorOf,
} from "@scalius/shared/plugins/providers";
import { AppError, NotFoundError } from "../../utils/api-error";
import { requestAppProviders } from "./app-providers";
import type { RequestLike } from "./runtime";

export const PAYOUT_PROVIDER_UNAVAILABLE_CODE = "payout_provider_unavailable";
export const PAYOUT_OUTCOME_UNKNOWN_CODE = "payout_outcome_unknown";
export const PAYOUT_REVERSAL_UNSUPPORTED_CODE = "payout_reversal_unsupported";
export const PAYOUT_REVERSAL_OUTCOME_UNKNOWN_CODE = "payout_reversal_outcome_unknown";
/** How long one provider call may take before its outcome counts as unknown. */
export const PAYOUT_CALL_TIMEOUT_MS = 20_000;

export type PayoutSendResult =
  | { outcome: "answered"; payout: Payout; created: boolean }
  /** The payout is recorded `pending` and the provider's answer is unknown: resubmit with the same request. */
  | { outcome: "unknown"; payout: Payout; created: boolean };

type PayoutProvider = BoundProvider<"payout">;

/** The payout provider, ready to call, or the merchant-facing reason it cannot be used. */
async function resolvePayoutProvider(c: RequestLike, providerId: string): Promise<PayoutProvider> {
  const choice = isQualifiedProviderId(providerId) ? await requestAppProviders(c).resolve("payout", providerId) : null;
  if (!choice?.provider) {
    throw new AppError(422, PAYOUT_PROVIDER_UNAVAILABLE_CODE,
      choice?.issue ?? "No installed app provides this payout provider. Install and set up a payout app first.",
      { providerId });
  }
  return choice.provider;
}

/** What a provider error means for the payout: a final failure, or an unknown outcome (null). */
function failureOf(error: unknown): PayoutAnswer | null {
  const failure = providerErrorOf(error);
  if (!failure || (failure.category !== "declined" && failure.category !== "misconfigured")) return null;
  return { status: "failed", failureCode: failure.code, failureMessage: failure.message };
}

function answerOf(result: { status: PayoutAnswer["status"]; providerRef: string; failureCode?: string; reason?: string }): PayoutAnswer {
  return {
    status: result.status,
    providerRef: result.providerRef,
    ...(result.status === "failed" ? { failureCode: result.failureCode ?? "payout_failed", failureMessage: result.reason ?? null } : {}),
  };
}

/** One call to the provider, bounded by the payout deadline. */
function call<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return work(AbortSignal.timeout(PAYOUT_CALL_TIMEOUT_MS));
}

/** Asks the provider for the payout's answer; null when it is unknown (never arrived, or no answer). */
async function askStatus(provider: PayoutProvider, payout: Payout): Promise<PayoutAnswer | null> {
  try {
    const answer = payoutStatusSchema.safeParse(await call((signal) => provider.payoutStatus({
      payoutId: payout.id,
      ...(payout.providerRef ? { providerRef: payout.providerRef } : {}),
    }, { signal })));
    if (!answer.success || answer.data.status === "unknown") return null;
    return answerOf(answer.data);
  } catch {
    // A failed question proves nothing: `createPayout` with the same id answers it.
    return null;
  }
}

/** Sends the payout; null when the provider's answer is unknown. */
async function create(provider: PayoutProvider, payout: Payout): Promise<PayoutAnswer | null> {
  try {
    const answer = payoutResultSchema.safeParse(await call((signal) => provider.createPayout({
      payoutId: payout.id,
      payee: { ref: payout.payeeRef, ...(payout.payeeAccountRef ? { accountRef: payout.payeeAccountRef } : {}) },
      amountMinor: payout.amountMinor,
      currency: payout.currency,
      ...(payout.description ? { description: payout.description } : {}),
    }, { signal })));
    return answer.success ? answerOf(answer.data) : null;
  } catch (error) {
    const failure = failureOf(error);
    if (!failure) {
      const known = providerErrorOf(error);
      console.warn(JSON.stringify({ event: "payout_outcome_unknown", payoutId: payout.id, code: known?.code ?? "provider_call_failed" }));
    }
    return failure;
  }
}

/** Applies an answer; a provider reference another payout already holds leaves this one pending. */
async function apply(db: Database, payout: Payout, answer: PayoutAnswer): Promise<Payout | null> {
  try {
    const applied = await applyPayoutAnswer(db, payout.id, answer, { appId: payout.appId });
    if (!applied || applied.skipped === "provider_ref_mismatch") return null;
    return applied.payout;
  } catch (error) {
    if (error instanceof Error && /UNIQUE|unique/.test(error.message)) {
      console.warn(JSON.stringify({ event: "payout_provider_ref_taken", payoutId: payout.id }));
      return null;
    }
    throw error;
  }
}

/** Sends (or resubmits) an app's payout: see the file comment. */
export async function sendPayout(c: RequestLike, request: PayoutRequest): Promise<PayoutSendResult> {
  const db = c.get("db");
  const existing = await findPayoutByKey(db, request);
  if (existing && existing.status !== "pending") return { outcome: "answered", payout: existing, created: false };

  const provider = await resolvePayoutProvider(c, request.providerId);
  const { payout, created } = existing ? { payout: existing, created: false } : await recordPayout(db, request);
  if (payout.status !== "pending") return { outcome: "answered", payout, created };

  // A resubmit asks first: the first call may have reached the provider.
  const answer = (created ? null : await askStatus(provider, payout)) ?? await create(provider, payout);
  const applied = answer ? await apply(db, payout, answer) : null;
  if (applied && applied.status !== "pending") return { outcome: "answered", payout: applied, created };
  return { outcome: "unknown", payout: applied ?? payout, created };
}

// ── Reversals ───────────────────────────────────────────────────────────────
//
// Taking money back from a paid payout (`payouts.reverse`), in the same
// order: a repeat of a key whose reversal is answered is answered from the
// record; the payout's provider must be ready and declare `reversePayout`
// (422 `payout_reversal_unsupported`, nothing written); the reversal is
// committed `pending` (core `recordPayoutReversal`: a paid payout of the app,
// at most what it has left to give back); the provider is called with
// `reversalId` = the reversal's id on every retry, asking `reversalStatus`
// first on a resubmit; its answer is applied forward only. A decline ends it
// `failed`; anything else leaves it `pending` for the same request to resume.

export type PayoutReversalResult =
  | { outcome: "answered"; reversal: PayoutReversal; created: boolean }
  /** The reversal is recorded `pending` and the provider's answer is unknown: resubmit with the same request. */
  | { outcome: "unknown"; reversal: PayoutReversal; created: boolean };

type ReversingProvider = PayoutProvider & Required<Pick<PayoutProvider, "reversePayout" | "reversalStatus">>;

/** The payout's provider, ready to reverse, or why it cannot. */
async function resolveReversingProvider(c: RequestLike, providerId: string): Promise<ReversingProvider> {
  const provider = await resolvePayoutProvider(c, providerId);
  if (!provider.reversePayout || !provider.reversalStatus) {
    throw new AppError(422, PAYOUT_REVERSAL_UNSUPPORTED_CODE,
      "The payout's provider cannot reverse payouts. Take the money back outside the store, or use a payout app that reverses.", { providerId });
  }
  return provider as ReversingProvider;
}

function reversalAnswerOf(result: { status: PayoutReversalAnswer["status"]; providerRef: string; failureCode?: string; reason?: string }): PayoutReversalAnswer {
  return {
    status: result.status,
    providerRef: result.providerRef,
    ...(result.status === "failed" ? { failureCode: result.failureCode ?? "payout_reversal_failed", failureMessage: result.reason ?? null } : {}),
  };
}

async function askReversalStatus(provider: ReversingProvider, reversal: PayoutReversal): Promise<PayoutReversalAnswer | null> {
  try {
    const answer = payoutReversalStatusSchema.safeParse(await call((signal) => provider.reversalStatus({
      reversalId: reversal.id,
      payoutId: reversal.payoutId,
      ...(reversal.providerRef ? { providerRef: reversal.providerRef } : {}),
    }, { signal })));
    if (!answer.success || answer.data.status === "unknown") return null;
    return reversalAnswerOf(answer.data);
  } catch {
    // A failed question proves nothing: `reversePayout` with the same id answers it.
    return null;
  }
}

async function reverse(provider: ReversingProvider, reversal: PayoutReversal, payout: Payout): Promise<PayoutReversalAnswer | null> {
  try {
    const answer = payoutReversalResultSchema.safeParse(await call((signal) => provider.reversePayout({
      reversalId: reversal.id,
      payoutId: payout.id,
      ...(payout.providerRef ? { providerRef: payout.providerRef } : {}),
      amountMinor: reversal.amountMinor,
      currency: reversal.currency,
      ...(reversal.reason ? { reason: reversal.reason } : {}),
    }, { signal })));
    return answer.success ? reversalAnswerOf(answer.data) : null;
  } catch (error) {
    const failure = failureOf(error);
    if (!failure) {
      const known = providerErrorOf(error);
      console.warn(JSON.stringify({ event: "payout_reversal_outcome_unknown", reversalId: reversal.id, code: known?.code ?? "provider_call_failed" }));
      return null;
    }
    return { status: "failed", failureCode: failure.failureCode ?? "payout_reversal_failed", failureMessage: failure.failureMessage ?? null };
  }
}

async function applyReversal(db: Database, reversal: PayoutReversal, answer: PayoutReversalAnswer): Promise<PayoutReversal | null> {
  try {
    const applied = await applyPayoutReversalAnswer(db, reversal.id, answer, { appId: reversal.appId });
    if (!applied || applied.skipped === "provider_ref_mismatch") return null;
    return applied.reversal;
  } catch (error) {
    if (error instanceof Error && /UNIQUE|unique/.test(error.message)) {
      console.warn(JSON.stringify({ event: "payout_reversal_provider_ref_taken", reversalId: reversal.id }));
      return null;
    }
    throw error;
  }
}

/** Reverses (or resumes the reversal of) part of an app's paid payout: see the comment above. */
export async function reversePayout(c: RequestLike, request: PayoutReversalRequest): Promise<PayoutReversalResult> {
  const db = c.get("db");
  const existing = await findPayoutReversalByKey(db, request);
  if (existing && existing.status !== "pending") return { outcome: "answered", reversal: existing, created: false };

  const payout = await getAppPayout(db, request.appId, request.payoutId);
  if (!payout) throw new NotFoundError("Payout not found");
  const provider = await resolveReversingProvider(c, payout.providerId);
  const { reversal, created } = existing ? { reversal: existing, created: false } : await recordPayoutReversal(db, request);
  if (reversal.status !== "pending") return { outcome: "answered", reversal, created };

  // A resubmit asks first: the first call may have reached the provider.
  const answer = (created ? null : await askReversalStatus(provider, reversal)) ?? await reverse(provider, reversal, payout);
  const applied = answer ? await applyReversal(db, reversal, answer) : null;
  if (applied && applied.status !== "pending") return { outcome: "answered", reversal: applied, created };
  return { outcome: "unknown", reversal: applied ?? reversal, created };
}
