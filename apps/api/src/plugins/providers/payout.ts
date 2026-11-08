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
  findPayoutByKey,
  recordPayout,
  type Payout,
  type PayoutAnswer,
  type PayoutRequest,
} from "@scalius/core/modules/payouts";
import {
  isQualifiedProviderId,
  payoutResultSchema,
  payoutStatusSchema,
  providerErrorOf,
} from "@scalius/shared/plugins/providers";
import { AppError } from "../../utils/api-error";
import { requestAppProviders } from "./app-providers";
import type { RequestLike } from "./runtime";

export const PAYOUT_PROVIDER_UNAVAILABLE_CODE = "payout_provider_unavailable";
export const PAYOUT_OUTCOME_UNKNOWN_CODE = "payout_outcome_unknown";
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
