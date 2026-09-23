// The payment gateway port. A gateway adapter speaks one provider's protocol;
// the kernel (session orchestration, webhook claim, payment application,
// refunds, reconciliation) is written once and never branches on a gateway id.
//
// Money crosses this boundary as integer minor units plus an ISO 4217 code.
// Adapters never touch the database; they read their own saved settings through
// `loadSettings` and must treat unreadable or placeholder credentials as not
// configured (fail closed).

import type { Database } from "@scalius/database/client";

export type PaymentType = "full" | "deposit" | "balance";

/** Card gateways confirm in the browser with a client secret; hosted gateways redirect. */
export type GatewayCheckoutFlow = "card" | "hosted";

export interface GatewaySettings {
  enabled: boolean;
  /** Stored credentials that could not be decrypted. Never call the provider with them. */
  credentialErrors?: string[];
}

export interface GatewayReadiness {
  configured: boolean;
  enabled: boolean;
  usable: boolean;
  missingFields: string[];
  credentialErrors?: string[];
  blockedReason?: string;
}

/** Provider-imposed charge limits, in minor units of `currency`. */
export interface GatewayAmountLimits {
  currency: string;
  minMinor: number;
  maxMinor: number;
}

export interface GatewaySessionInput {
  /** Locally claimed attempt key; adapters pass it as the provider idempotency key when supported. */
  attemptKey: string;
  /** Merchant reference sent to the provider (at most 30 characters, see correlation.ts). */
  correlationId: string;
  orderId: string;
  paymentType: PaymentType;
  amountMinor: number;
  currency: string;
  buyer: {
    name: string;
    phone: string;
    email?: string;
    address?: string;
    city?: string;
  };
  urls: { success: string; fail: string; cancel: string; webhook: string };
  signal: AbortSignal;
  requestTimeoutMs: number;
}

export interface GatewaySession {
  /** Provider session/intent reference, stored as the order recovery hint. */
  providerRef?: string;
  /** Hosted flows: where the buyer is sent to pay. */
  redirectUrl?: string;
  /** Card flows: the browser confirmation secret and the public key that confirms it. */
  clientSecret?: string;
  publishableKey?: string;
}

/**
 * A provider-authenticated fact about one payment, normalized for the kernel.
 * `eventType` + `eventId` identify the provider event for claim-once; the same
 * provider fact reached through a webhook and a buyer return must produce the
 * same pair so that only one of them is applied.
 */
export interface PaymentEvent {
  kind: "confirmed" | "failed" | "cancelled" | "refund_observed";
  eventType: string;
  eventId: string;
  orderId: string;
  /** Unique per provider: the reference the kernel dedupes captured payments on. */
  providerRef: string;
  /** The captured-transaction reference refunds are issued against. */
  secondaryRef?: string;
  /** Confirmed events: the provider-validated amount and currency. */
  amountMinor?: number;
  currency?: string;
  /** Confirmed events: payment type bound into provider-validated metadata, when present. */
  paymentType?: PaymentType;
  /** Small audit facts stored with the payment row. Never PII or secrets. */
  details?: Record<string, string | number | boolean | null>;
}

export interface GatewayRequest {
  method: string;
  rawBody: string;
  headers: Headers;
  query: Record<string, string>;
}

export type GatewayVerification =
  | { status: "event"; event: PaymentEvent }
  /** Authentic (or unverifiable but harmless) and not actionable. */
  | { status: "ignored"; reason: string }
  /** Authenticity check failed. No state may change. */
  | { status: "invalid"; reason: string }
  /** The provider could not be asked yet; the caller should be told to retry. */
  | { status: "retry"; reason: string };

export interface GatewayPaymentQuery {
  providerStatus: string;
  /** Present only when the provider reports the payment as captured. */
  event?: PaymentEvent;
}

export interface GatewayRefundInput {
  providerRef: string;
  secondaryRef: string | null;
  amountMinor: number;
  currency: string;
  reason: string;
  /** Deterministic per allocation; retries reuse it. */
  idempotencyKey: string;
  /** Deterministic merchant refund reference (at most 30 characters). */
  reference: string;
  metadata: Record<string, string>;
}

export interface GatewayRefundProbeInput {
  providerRefundId: string | null;
  sourceRef: string | null;
  amountMinor: number;
  currency: string;
  reference: string;
  idempotencyKey: string;
}

export type GatewayRefundProbe =
  | {
      outcome: "accepted";
      providerRefundId?: string | null;
      providerStatus: string;
      responsePayload?: Record<string, unknown>;
    }
  | {
      outcome: "processing" | "unknown";
      providerRefundId?: string | null;
      providerStatus?: string;
      error?: string;
      responsePayload?: Record<string, unknown>;
      manualReview?: boolean;
    }
  | {
      outcome: "rejected";
      providerRefundId?: string | null;
      providerStatus: string;
      error?: string;
      responsePayload?: Record<string, unknown>;
    };

export interface GatewayProviderRefund {
  id: string;
  succeeded: boolean;
  amountMinor: number;
  currency: string;
  sourceRef: string | null;
  status: string | null;
}

/** A provider rejected or could not complete a call. `timedOut` maps to a retryable 503. */
export class PaymentProviderError extends Error {
  readonly timedOut: boolean;

  constructor(message: string, options: { timedOut?: boolean } = {}) {
    super(message);
    this.name = "PaymentProviderError";
    this.timedOut = options.timedOut === true;
  }
}

export interface PaymentGateway<S extends GatewaySettings = GatewaySettings> {
  readonly id: string;
  /** Merchant-facing provider name. */
  readonly label: string;
  /** Buyer-facing default method name shown by checkout. */
  readonly checkoutName: string;
  readonly flow: GatewayCheckoutFlow;
  /** ISO 4217 codes the provider settles, or "any" for every store currency. */
  readonly currencies: readonly string[] | "any";
  readonly amountLimits?: GatewayAmountLimits;
  readonly supportsRefund: boolean;

  /** Saved settings, decrypted strictly; null when nothing was ever saved. */
  loadSettings(db: Database, encryptionKey: string | undefined): Promise<S | null>;
  /** Checkout readiness. Must fail closed on missing, unreadable, or placeholder credentials. */
  readiness(settings: S | null): GatewayReadiness;
  /** Whether saved credentials are complete enough to authenticate provider callbacks. */
  canVerify(settings: S): boolean;
  /** Test or live credentials, shown to the merchant. */
  environment(settings: S | null): "test" | "live" | "mixed" | "unknown";
  /** Public, non-secret checkout configuration for the storefront. */
  publicConfig?(settings: S): Record<string, unknown>;

  createSession(settings: S, input: GatewaySessionInput): Promise<GatewaySession>;
  verifyWebhook(settings: S, request: GatewayRequest): Promise<GatewayVerification>;
  /** Hosted flows: verify the buyer's success return with the provider. */
  verifyReturn?(settings: S, request: GatewayRequest, signal: AbortSignal): Promise<GatewayVerification>;
  /** Hosted flows: the provider-posted correlation id on an unsuccessful return (never authority). */
  returnCorrelationId?(request: GatewayRequest): string;
  /** Buyer-requested reconciliation of a session the provider may already have captured. */
  query?(
    settings: S,
    input: { providerRef: string; orderId: string },
    requestTimeoutMs: number,
  ): Promise<GatewayPaymentQuery>;
  refund?(settings: S, input: GatewayRefundInput): Promise<{ refundId?: string }>;
  refundStatus?(settings: S, input: GatewayRefundProbeInput): Promise<GatewayRefundProbe>;
  /** Refunds the provider knows about for a captured transaction (imports refunds made outside Scalius). */
  listRefunds?(settings: S, sourceRef: string): Promise<GatewayProviderRefund[]>;
}

export function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isProviderTimeoutError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (!error || typeof error !== "object") return false;
  const maybeError = error as { name?: unknown; message?: unknown; code?: unknown };
  const text = [maybeError.name, maybeError.message, maybeError.code]
    .map((value) => typeof value === "string" ? value.toLowerCase() : "")
    .join(" ");
  return text.includes("timeout") || text.includes("timed out") || text.includes("abort");
}

/** Major-unit decimal string ("150.00") → integer minor units, exact for well-formed input. */
export function majorStringToMinor(value: string, decimalPlaces: number): number | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const fraction = (match[2] ?? "").padEnd(decimalPlaces, "0");
  if (fraction.length > decimalPlaces && /[^0]/.test(fraction.slice(decimalPlaces))) return null;
  const minor = Number(`${match[1]}${fraction.slice(0, decimalPlaces)}`);
  return Number.isSafeInteger(minor) ? minor : null;
}

export function minorToMajorString(amountMinor: number, decimalPlaces: number): string {
  return (amountMinor / 10 ** decimalPlaces).toFixed(decimalPlaces);
}
