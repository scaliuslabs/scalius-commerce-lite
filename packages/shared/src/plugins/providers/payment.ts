// The payment port. A provider speaks one gateway's protocol; the payment
// kernel (session attempts, the webhook claim, payment application, refunds,
// reconciliation) is written once and never asks which provider it talks to.
//
// Rules every implementation keeps:
// - Money is integer minor units plus an ISO 4217 code. The platform encodes
//   the wire form once (`wireAmount`, amount.ts) from the provider's declared
//   codecs; a provider sends exactly that. Amounts a provider reports
//   (events, refunds) are ISO minor units again: an adapter whose wire form
//   differs decodes them with `decodeProviderAmount`.
// - The platform claims an attempt locally before `createSession`, so the
//   order exists before any provider side effect; `attemptKey` is stable
//   across retries of that attempt: pass it as the provider's idempotency key.
// - Only a provider-authenticated fact (a verified signature, or the
//   provider's own server-to-server answer) is a `PaymentEvent`. Anything
//   unauthenticated is `invalid` (no state changes) or `ignored`.
// - `eventType` + `eventId` name the provider fact: the same capture reached
//   through a webhook and through the buyer's return must produce the same
//   pair, so it is applied once.
// - A call that may have reached the provider but gave no answer raises
//   `ProviderError("retryable", …, { uncertain: true })`: the platform keeps
//   the operation for reconciliation and never repeats it blindly.
// - Saved payment methods are vaulted by the provider. The platform keeps
//   only the provider's opaque reference and display facts (brand, last four
//   digits, expiry, a label): never a card number, a CVC or a raw payload.
//   An off-session charge, a capture and a void each take a key that is
//   stable across retries of the same operation (pass it to the provider as
//   its idempotency key): a retry after a lost answer asks again, and the
//   provider answers the first outcome instead of charging twice.

import { z } from "zod";
import { providerWireAmountSchema } from "./amount";
import {
  providerCurrencySchema,
  providerDetailsSchema,
  providerHttpRequestSchema,
  providerIdempotencyKeySchema,
  providerMinorSchema,
  providerPositiveMinorSchema,
  providerReasonSchema,
  providerRefSchema,
} from "./common";

export const PAYMENT_TYPES = ["full", "deposit", "balance"] as const;
export const paymentTypeSchema = z.enum(PAYMENT_TYPES);
export type PaymentType = z.infer<typeof paymentTypeSchema>;

/**
 * How the buyer pays: `card` confirms in the storefront with a client
 * secret (built-in card gateways); `hosted` redirects to the provider's page
 * (wallets, hosted card pages); `deferred` charges nothing at checkout: the
 * order commits unpaid with a due date (`dueInDays`) and is paid later
 * (`@scalius/shared/payment-terms`), its payments arriving as provider events.
 */
export const PAYMENT_FLOWS = ["card", "hosted", "deferred"] as const;
export type PaymentFlow = (typeof PAYMENT_FLOWS)[number];

/** A provider's charge limits, in minor units of `currency`. */
export const paymentAmountLimitsSchema = z.object({
  currency: providerCurrencySchema,
  minMinor: providerMinorSchema,
  maxMinor: providerMinorSchema,
}).strict().refine((limits) => limits.maxMinor >= limits.minMinor, "maxMinor must be at least minMinor.");
export type PaymentAmountLimits = z.infer<typeof paymentAmountLimitsSchema>;

const httpUrl = z.string().url().max(2048).refine((value) => /^https?:\/\//.test(value), "Use an http(s) URL.");
const httpsUrl = z.string().url().max(2048).refine((value) => value.startsWith("https://"), "Use an https URL.");

// ── createSession ───────────────────────────────────────────────────────────

export const paymentSessionInputSchema = z.object({
  /** The locally claimed attempt: the provider idempotency key. */
  attemptKey: providerIdempotencyKeySchema,
  /** The merchant reference to send the provider (at most 30 characters; it comes back on returns). */
  correlationId: z.string().min(1).max(30),
  orderId: providerRefSchema,
  paymentType: paymentTypeSchema,
  /** What this session charges, in ISO minor units (after the provider's codec). */
  amountMinor: providerPositiveMinorSchema,
  currency: providerCurrencySchema,
  /** The same amount in the provider's wire form. */
  wireAmount: providerWireAmountSchema,
  /**
   * The buyer as the app may see them (COMMERCE-HOOKS H5): `name`, `email`,
   * `phone` and the street `address` are present only when the app holds
   * `read_customer_names`, `_emails`, `_phones` or `_addresses`. `city` is
   * the region and always sent when known.
   */
  buyer: z.object({
    name: z.string().max(200).optional(),
    /** Also absent for an order placed without a phone (a digital or service order outside Bangladesh). */
    phone: z.string().max(40).optional(),
    email: z.string().max(320).optional(),
    address: z.string().max(2000).optional(),
    city: z.string().max(200).optional(),
  }).strict(),
  /** Where the provider sends the buyer back, and where it posts webhooks. */
  urls: z.object({ success: httpUrl, fail: httpUrl, cancel: httpUrl, webhook: httpUrl }).strict(),
  /** The time this call may take; the platform aborts it after that. */
  requestTimeoutMs: z.number().int().min(1).max(30_000),
  /**
   * Present when the platform asks the provider to keep the buyer's payment
   * method for later charges without the buyer (a subscription's renewals):
   * only for a signed-in account customer, and only when the provider
   * declares the `vault` capability. The provider's confirmed or authorized
   * event then names the kept method (`savedPaymentMethod`).
   */
  savePaymentMethod: z.object({
    /** The account customer the method is kept for (the platform's id). */
    customerId: providerRefSchema,
    usage: z.literal("off_session"),
  }).strict().optional(),
}).strict();
export type PaymentSessionInput = z.infer<typeof paymentSessionInputSchema>;

export const paymentSessionSchema = z.object({
  /** The provider's session or payment reference: kept as the order's recovery hint. */
  providerRef: providerRefSchema.optional(),
  /** Hosted flows: where the buyer is sent to pay. */
  redirectUrl: httpsUrl.optional(),
  /** Card flows (built-in gateways): the browser confirmation secret and its public key. */
  clientSecret: z.string().max(4096).optional(),
  publishableKey: z.string().max(4096).optional(),
}).strict();
export type PaymentSession = z.infer<typeof paymentSessionSchema>;

// ── Provider facts ──────────────────────────────────────────────────────────

/**
 * Settlement facts of a captured payment, when the provider reports them
 * (D2): what reaches the merchant, in which currency, at which rate.
 */
export const paymentSettlementSchema = z.object({
  currency: providerCurrencySchema,
  amountMinor: providerMinorSchema,
  feeMinor: providerMinorSchema.optional(),
  /** Presentment → settlement rate as a decimal string; absent for same-currency settlement. */
  exchangeRate: z.string().regex(/^\d+(?:\.\d+)?$/).max(32).optional(),
}).strict();
export type PaymentSettlement = z.infer<typeof paymentSettlementSchema>;

/**
 * A payment method the provider kept for later off-session charges: its
 * opaque reference at the provider and what a buyer or staff member may see
 * of it. Never a card number, a CVC or a provider payload.
 */
export const savedPaymentMethodSchema = z.object({
  /** The provider's reference to the kept method (Stripe: a PaymentMethod id). */
  ref: providerRefSchema,
  /** The card network or wallet (`visa`, `bkash`), lower case. */
  brand: z.string().regex(/^[a-z0-9_-]{1,40}$/).optional(),
  last4: z.string().regex(/^\d{4}$/).optional(),
  expiryMonth: z.number().int().min(1).max(12).optional(),
  expiryYear: z.number().int().min(2000).max(2200).optional(),
  /** What the buyer calls it, or a wallet account's masked name. */
  label: z.string().trim().min(1).max(80).optional(),
}).strict();
export type SavedPaymentMethod = z.infer<typeof savedPaymentMethodSchema>;

/**
 * `confirmed`: money captured. `authorized`: money held at the provider and
 * not captured (manual capture); it counts as nothing paid until a capture
 * confirms it under the same `providerRef`. `failed` / `cancelled` end one
 * attempt, or, naming an authorization's `providerRef`, release that hold.
 */
export const PAYMENT_EVENT_KINDS = ["confirmed", "authorized", "failed", "cancelled", "refund_observed"] as const;
export type PaymentEventKind = (typeof PAYMENT_EVENT_KINDS)[number];

export const paymentEventSchema = z.object({
  kind: z.enum(PAYMENT_EVENT_KINDS),
  eventType: z.string().min(1).max(128),
  eventId: providerRefSchema,
  orderId: providerRefSchema,
  /** Unique per provider: the reference a captured payment is deduplicated on. */
  providerRef: providerRefSchema,
  /** The captured-transaction reference refunds are issued against. */
  secondaryRef: providerRefSchema.optional(),
  /** Confirmed events: the provider-authenticated amount and currency. */
  amountMinor: providerMinorSchema.optional(),
  currency: providerCurrencySchema.optional(),
  /** Confirmed events: the payment type bound into provider-authenticated metadata, when present. */
  paymentType: paymentTypeSchema.optional(),
  /**
   * Failed and cancelled returns: the merchant reference (`correlationId`)
   * the provider authenticated, which selects the attempt to release.
   */
  correlationId: z.string().min(1).max(30).optional(),
  settlement: paymentSettlementSchema.optional(),
  /** Confirmed and authorized events of a session that asked to keep the method (`savePaymentMethod`). */
  savedPaymentMethod: savedPaymentMethodSchema.optional(),
  details: providerDetailsSchema.optional(),
}).strict().superRefine((event, context) => {
  const holdsMoney = event.kind === "confirmed" || event.kind === "authorized";
  if (holdsMoney && (event.amountMinor === undefined || event.currency === undefined)) {
    context.addIssue({ code: "custom", message: `A ${event.kind} payment carries its authenticated amount and currency.` });
  }
  if (!holdsMoney && event.savedPaymentMethod !== undefined) {
    context.addIssue({ code: "custom", path: ["savedPaymentMethod"], message: "Only a confirmed or authorized payment names a saved payment method." });
  }
});
export type PaymentEvent = z.infer<typeof paymentEventSchema>;

const reason = z.string().min(1).max(300);

/** The outcome of authenticating a webhook or a buyer return. */
export const paymentVerificationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("event"), event: paymentEventSchema }).strict(),
  /** Authentic (or unverifiable but harmless) and nothing to apply. */
  z.object({ status: z.literal("ignored"), reason }).strict(),
  /** Authentication failed: nothing may change. */
  z.object({ status: z.literal("invalid"), reason }).strict(),
  /** The provider could not be asked yet: the sender should retry. */
  z.object({ status: z.literal("retry"), reason }).strict(),
]);
export type PaymentVerification = z.infer<typeof paymentVerificationSchema>;

// ── queryPayment ────────────────────────────────────────────────────────────

export const paymentQueryInputSchema = z.object({
  providerRef: providerRefSchema,
  orderId: providerRefSchema,
  requestTimeoutMs: z.number().int().min(1).max(30_000),
}).strict();
export type PaymentQueryInput = z.infer<typeof paymentQueryInputSchema>;

export const paymentQuerySchema = z.object({
  providerStatus: z.string().min(1).max(100),
  /** Present only when the provider reports the payment captured. */
  event: paymentEventSchema.optional(),
}).strict();
export type PaymentQuery = z.infer<typeof paymentQuerySchema>;

// ── Refunds ─────────────────────────────────────────────────────────────────

export const paymentRefundInputSchema = z.object({
  providerRef: providerRefSchema,
  secondaryRef: providerRefSchema.nullable(),
  amountMinor: providerPositiveMinorSchema,
  currency: providerCurrencySchema,
  wireAmount: providerWireAmountSchema,
  reason: z.string().max(300),
  /** Deterministic per refund allocation; retries reuse it. */
  idempotencyKey: providerIdempotencyKeySchema,
  /** Deterministic merchant refund reference (at most 30 characters). */
  reference: z.string().min(1).max(30),
  metadata: z.record(z.string().max(64), z.string().max(500)),
}).strict();
export type PaymentRefundInput = z.infer<typeof paymentRefundInputSchema>;

export const paymentRefundSchema = z.object({
  /** The provider's refund reference, when it gives one. */
  refundId: providerRefSchema.optional(),
}).strict();
export type PaymentRefund = z.infer<typeof paymentRefundSchema>;

export const paymentRefundProbeInputSchema = z.object({
  providerRefundId: providerRefSchema.nullable(),
  sourceRef: providerRefSchema.nullable(),
  amountMinor: providerPositiveMinorSchema,
  currency: providerCurrencySchema,
  reference: z.string().min(1).max(30),
  idempotencyKey: providerIdempotencyKeySchema,
}).strict();
export type PaymentRefundProbeInput = z.infer<typeof paymentRefundProbeInputSchema>;

const responsePayload = z.record(z.string(), z.unknown());
/** What the provider says about a refund whose outcome was not known. */
export const paymentRefundProbeSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("accepted"),
    providerRefundId: providerRefSchema.nullable().optional(),
    providerStatus: z.string().min(1).max(100),
    responsePayload: responsePayload.optional(),
  }).strict(),
  z.object({
    outcome: z.enum(["processing", "unknown"]),
    providerRefundId: providerRefSchema.nullable().optional(),
    providerStatus: z.string().max(100).optional(),
    error: reason.optional(),
    responsePayload: responsePayload.optional(),
    manualReview: z.boolean().optional(),
  }).strict(),
  z.object({
    outcome: z.literal("rejected"),
    providerRefundId: providerRefSchema.nullable().optional(),
    providerStatus: z.string().min(1).max(100),
    error: reason.optional(),
    responsePayload: responsePayload.optional(),
  }).strict(),
]);
export type PaymentRefundProbe = z.infer<typeof paymentRefundProbeSchema>;

export const paymentListRefundsInputSchema = z.object({ sourceRef: providerRefSchema }).strict();
export type PaymentListRefundsInput = z.infer<typeof paymentListRefundsInputSchema>;

/** Refunds the provider knows for a captured transaction (imports refunds made outside Scalius). */
export const providerRefundsSchema = z.array(z.object({
  id: providerRefSchema,
  succeeded: z.boolean(),
  amountMinor: providerMinorSchema,
  currency: providerCurrencySchema,
  sourceRef: providerRefSchema.nullable(),
  status: z.string().max(100).nullable(),
}).strict()).max(100);
export type ProviderRefunds = z.infer<typeof providerRefundsSchema>;

// ── Saved methods: off-session charge, capture, void, delete ────────────────

/**
 * What a provider declares it can do beyond sessions, so the platform knows
 * before it calls: `vault` (it keeps payment methods and charges them
 * off-session: `chargeSavedMethod`, `deleteSavedMethod`) and `manualCapture`
 * (it authorizes now and captures or voids later: `capture`, `void`).
 */
export const PAYMENT_CAPABILITIES = ["vault", "manualCapture"] as const;
export type PaymentCapability = (typeof PAYMENT_CAPABILITIES)[number];

/** The optional operations each capability brings (the descriptor declares both or neither). */
export const PAYMENT_CAPABILITY_OPERATIONS = {
  vault: ["chargeSavedMethod", "deleteSavedMethod"],
  manualCapture: ["capture", "void"],
} as const satisfies Record<PaymentCapability, readonly string[]>;

const declinedOutcome = z.object({
  status: z.literal("declined"),
  reason,
  /** A short stable code (`card_declined`, `insufficient_funds`); never a raw provider body. */
  code: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/).optional(),
}).strict();
/** The provider accepted the request; its answer arrives later as a verified webhook. */
const pendingOutcome = z.object({
  status: z.literal("pending"),
  /** The provider's payment reference, when it already has one. */
  providerRef: providerRefSchema.optional(),
}).strict();

export const paymentChargeInputSchema = z.object({
  /** The locally claimed charge: the provider idempotency key, stable across retries. */
  attemptKey: providerIdempotencyKeySchema,
  /** The merchant reference to send the provider (at most 30 characters). */
  correlationId: z.string().min(1).max(30),
  orderId: providerRefSchema,
  paymentType: paymentTypeSchema,
  amountMinor: providerPositiveMinorSchema,
  currency: providerCurrencySchema,
  wireAmount: providerWireAmountSchema,
  /** The saved method's provider reference (`savedPaymentMethod.ref`). */
  methodRef: providerRefSchema,
  /** `automatic` captures now (`confirmed`); `manual` only authorizes (`authorized`) for a later `capture`. */
  capture: z.enum(["automatic", "manual"]),
  requestTimeoutMs: z.number().int().min(1).max(30_000),
}).strict();
export type PaymentChargeInput = z.infer<typeof paymentChargeInputSchema>;

/**
 * A provider-authenticated outcome of an off-session charge: the payment
 * event (`confirmed`, or `authorized` for a manual capture), `pending` (a
 * verified webhook follows), or `declined`. No answer at all is a
 * `ProviderError("retryable", …, { uncertain: true })`.
 */
export const paymentChargeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("event"), event: paymentEventSchema }).strict(),
  pendingOutcome,
  declinedOutcome,
]).superRefine((outcome, context) => {
  if (outcome.status === "event" && outcome.event.kind !== "confirmed" && outcome.event.kind !== "authorized") {
    context.addIssue({ code: "custom", path: ["event", "kind"], message: "A charge answers a confirmed or authorized payment." });
  }
});
export type PaymentCharge = z.infer<typeof paymentChargeSchema>;

export const paymentCaptureInputSchema = z.object({
  /** The authorization's provider reference (its `authorized` event's `providerRef`). */
  providerRef: providerRefSchema,
  orderId: providerRefSchema,
  /** What to capture: at most what was authorized. */
  amountMinor: providerPositiveMinorSchema,
  currency: providerCurrencySchema,
  wireAmount: providerWireAmountSchema,
  idempotencyKey: providerIdempotencyKeySchema,
}).strict();
export type PaymentCaptureInput = z.infer<typeof paymentCaptureInputSchema>;

/** A capture's provider-authenticated outcome: the `confirmed` event under the authorization's `providerRef`. */
export const paymentCaptureSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("event"), event: paymentEventSchema }).strict(),
  pendingOutcome,
  declinedOutcome,
]).superRefine((outcome, context) => {
  if (outcome.status === "event" && outcome.event.kind !== "confirmed") {
    context.addIssue({ code: "custom", path: ["event", "kind"], message: "A capture answers a confirmed payment." });
  }
});
export type PaymentCapture = z.infer<typeof paymentCaptureSchema>;

export const paymentVoidInputSchema = z.object({
  providerRef: providerRefSchema,
  orderId: providerRefSchema,
  idempotencyKey: providerIdempotencyKeySchema,
}).strict();
export type PaymentVoidInput = z.infer<typeof paymentVoidInputSchema>;

/** A void's provider-authenticated outcome: the hold is released (`voided`), will be (`pending`), or cannot be (`declined`: captured already). */
export const paymentVoidSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("voided") }).strict(),
  pendingOutcome,
  declinedOutcome,
]);
export type PaymentVoid = z.infer<typeof paymentVoidSchema>;

export const paymentDeleteSavedMethodInputSchema = z.object({
  ref: providerRefSchema,
  idempotencyKey: providerIdempotencyKeySchema,
}).strict();
export type PaymentDeleteSavedMethodInput = z.infer<typeof paymentDeleteSavedMethodInputSchema>;

/** `deleted`, or `not_found` (the provider no longer knows it: nothing is left to detach). */
export const paymentDeleteSavedMethodSchema = z.object({
  status: z.enum(["deleted", "not_found"]),
}).strict();
export type PaymentDeleteSavedMethod = z.infer<typeof paymentDeleteSavedMethodSchema>;

/** The schemas of every payment operation: the host validates both sides of each call. */
export const PAYMENT_PORT = {
  createSession: { input: paymentSessionInputSchema, output: paymentSessionSchema },
  verifyWebhook: { input: providerHttpRequestSchema, output: paymentVerificationSchema },
  verifyReturn: { input: providerHttpRequestSchema, output: paymentVerificationSchema },
  queryPayment: { input: paymentQueryInputSchema, output: paymentQuerySchema },
  refund: { input: paymentRefundInputSchema, output: paymentRefundSchema },
  refundStatus: { input: paymentRefundProbeInputSchema, output: paymentRefundProbeSchema },
  listRefunds: { input: paymentListRefundsInputSchema, output: providerRefundsSchema },
  chargeSavedMethod: { input: paymentChargeInputSchema, output: paymentChargeSchema },
  capture: { input: paymentCaptureInputSchema, output: paymentCaptureSchema },
  void: { input: paymentVoidInputSchema, output: paymentVoidSchema },
  deleteSavedMethod: { input: paymentDeleteSavedMethodInputSchema, output: paymentDeleteSavedMethodSchema },
} as const;
