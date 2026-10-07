// The payment gateway as the kernel sees it: the shared payment port
// (`@scalius/shared/plugins/providers/payment`, the same port app providers
// implement) plus how the platform configures it. A gateway adapter speaks
// one provider's protocol; the kernel (session orchestration, webhook claim,
// payment application, refunds, reconciliation) is written once and never
// branches on a gateway id, or on whether the gateway is built in or an app.
//
// Money crosses this boundary as integer minor units plus an ISO 4217 code;
// the wire form is encoded once from the gateway's codecs. Adapters never
// touch the database; they read their own saved settings through
// `loadSettings` and must treat unreadable or placeholder credentials as not
// configured (fail closed).

import type { Database } from "@scalius/database/client";
import type {
  PaymentAmountLimits,
  PaymentEvent as PortPaymentEvent,
  PaymentFlow,
  PaymentRefundProbe,
  PaymentSessionInput,
  PaymentVerification,
  ProviderAmountCodecs,
  ProviderCountries,
  ProviderHttpRequest,
  ProviderPort,
  ProviderRefunds,
} from "@scalius/shared/plugins/providers";

export type { PaymentType } from "@scalius/shared/plugins/providers";

/** Card gateways confirm in the browser with a client secret; hosted gateways redirect; instruction gateways tell the buyer what to do. */
export type GatewayCheckoutFlow = PaymentFlow;

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
export type GatewayAmountLimits = PaymentAmountLimits;
export type GatewaySessionInput = PaymentSessionInput;
/**
 * A provider-authenticated fact about one payment, normalized for the kernel.
 * `eventType` + `eventId` identify the provider event for claim-once; the same
 * provider fact reached through a webhook and a buyer return must produce the
 * same pair so that only one of them is applied.
 */
export type PaymentEvent = PortPaymentEvent;
export type GatewayRequest = ProviderHttpRequest;
export type GatewayVerification = PaymentVerification;
export type GatewayRefundProbe = PaymentRefundProbe;
export type GatewayProviderRefund = ProviderRefunds[number];

/** What every port call of a gateway gets besides its input. */
export interface GatewayCall<S extends GatewaySettings = GatewaySettings> {
  /** The gateway's saved settings, read with `loadSettings` for this request. */
  settings: S;
  /** Aborts the provider call at the kernel's deadline. */
  signal: AbortSignal;
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

export interface PaymentGateway<S extends GatewaySettings = GatewaySettings> extends ProviderPort<"payment", GatewayCall<S>> {
  /** `stripe`, or an app provider's `<plugin id>:<provider id>` (a retired built-in id resolves to one). */
  readonly id: string;
  /** Merchant-facing provider name. */
  readonly label: string;
  /** Buyer-facing default method name shown by checkout. */
  readonly checkoutName: string;
  readonly flow: GatewayCheckoutFlow;
  /** ISO 4217 codes the provider can charge, or "any" for every store currency. */
  readonly chargeCurrencies: readonly string[] | "any";
  /**
   * The shipping countries it serves (absent: any). Checkout never offers it
   * for an order delivered elsewhere.
   */
  readonly countries?: ProviderCountries;
  readonly amountLimits?: GatewayAmountLimits;
  /** Per-currency wire forms (`encodeProviderAmount`); absent: ISO minor units as they are. */
  readonly amountCodecs?: ProviderAmountCodecs;
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
  /**
   * Hosted flows whose provider posts an unsigned correlation id on a failed
   * or cancelled return (never authority). A gateway without it answers
   * every return through `verifyReturn`, authenticated with the provider.
   */
  returnCorrelationId?(request: GatewayRequest): string;
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
