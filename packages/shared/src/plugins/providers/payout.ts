// The payout port: money the store sends to a payee (a marketplace's seller,
// an affiliate) through a payout service (bKash disbursement, a bank
// transfer API, Stripe Connect). Core keeps the payout record; the provider
// moves the money.
//
// Rules every implementation keeps:
// - Money is integer minor units plus an ISO 4217 code, never a float.
// - The platform commits the payout (`pending`) before `createPayout` runs,
//   and `payoutId` is stable across every retry of it: apply a payout once
//   per `payoutId` (the provider's idempotency key, or the app's own record
//   keyed on it). A retry of an unanswered payout calls `createPayout` again
//   with the same `payoutId`; it must answer the first payout, never send a
//   second one.
// - `payee.accountRef` is the provider's own reference for the payee's
//   account (a wallet number, a connected account id): the store keeps it
//   only as the app gave it.
// - A call that may have reached the provider but gave no answer raises
//   `ProviderError("retryable", …, { uncertain: true })`: the payout stays
//   `pending` and is asked about again (`payoutStatus`, or a later retry).
// - Only a provider-authenticated fact moves a payout: an answer to the
//   platform's own call or a verified callback (`verifyWebhook`). Statuses
//   only move forward: `processing`, then `paid` or `failed`.

import { z } from "zod";
import {
  providerCurrencySchema,
  providerHttpRequestSchema,
  providerPositiveMinorSchema,
  providerReasonSchema,
  providerRefSchema,
} from "./common";

/** What a payout is at the provider: taken and on its way, settled, or refused. */
export const PROVIDER_PAYOUT_STATUSES = ["processing", "paid", "failed"] as const;
export type ProviderPayoutStatus = (typeof PROVIDER_PAYOUT_STATUSES)[number];

const failureCode = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/);

export const payoutCreateInputSchema = z.object({
  /** The platform's payout id: apply the payout once per id. */
  payoutId: providerRefSchema,
  payee: z.object({
    /** The app's own reference for the payee (a seller id). */
    ref: z.string().min(1).max(128),
    /** The provider's reference for the payee's account; absent when the provider looks it up from `ref`. */
    accountRef: providerRefSchema.optional(),
  }).strict(),
  amountMinor: providerPositiveMinorSchema,
  currency: providerCurrencySchema,
  /** Shown on the payee's statement where the provider supports it. */
  description: z.string().min(1).max(200).optional(),
}).strict();
export type PayoutCreateInput = z.infer<typeof payoutCreateInputSchema>;

/** The provider's answer about one payout. `failed` names why (`failureCode`, a merchant-safe `reason`). */
export const payoutResultSchema = z.object({
  status: z.enum(PROVIDER_PAYOUT_STATUSES),
  /** The provider's id for the payout. */
  providerRef: providerRefSchema,
  failureCode: failureCode.optional(),
  reason: providerReasonSchema.optional(),
}).strict();
export type PayoutResult = z.infer<typeof payoutResultSchema>;

export const payoutStatusInputSchema = z.object({
  payoutId: providerRefSchema,
  /** Absent when the first call never answered: look the payout up by `payoutId`. */
  providerRef: providerRefSchema.optional(),
}).strict();
export type PayoutStatusInput = z.infer<typeof payoutStatusInputSchema>;

/** The provider's answer to a status question; `unknown` when it has no payout under that id (it never arrived). */
export const payoutStatusSchema = z.union([
  payoutResultSchema,
  z.object({ status: z.literal("unknown") }).strict(),
]);
export type PayoutStatusAnswer = z.infer<typeof payoutStatusSchema>;

/**
 * An authenticated callback about payouts, or why nothing applies. Each
 * update names the payout by the platform's `payoutId` (when the provider
 * echoes it) or its own `providerRef`.
 */
export const payoutWebhookSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("updates"),
    updates: z.array(z.object({
      payoutId: providerRefSchema.optional(),
      providerRef: providerRefSchema,
      status: z.enum(PROVIDER_PAYOUT_STATUSES),
      failureCode: failureCode.optional(),
      reason: providerReasonSchema.optional(),
    }).strict()).min(1).max(50),
  }).strict(),
  z.object({ status: z.literal("ignored"), reason: providerReasonSchema }).strict(),
  z.object({ status: z.literal("invalid"), reason: providerReasonSchema }).strict(),
]);
export type PayoutWebhook = z.infer<typeof payoutWebhookSchema>;

export const PAYOUT_PORT = {
  createPayout: { input: payoutCreateInputSchema, output: payoutResultSchema },
  payoutStatus: { input: payoutStatusInputSchema, output: payoutStatusSchema },
  verifyWebhook: { input: providerHttpRequestSchema, output: payoutWebhookSchema },
} as const;
