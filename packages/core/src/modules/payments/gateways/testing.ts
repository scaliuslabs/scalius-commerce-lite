// Test-only: a complete hosted gateway with no provider behind it, under an
// app provider id. Passing it in a request's providers is the proof that a
// new gateway needs nothing else from the kernel. Never import this from
// Worker code.

import { ValidationError } from "@scalius/core/errors";
import { createPaymentProviders, type PaymentProviders } from "./registry";
import type {
  GatewayProviderRefund,
  GatewayRefundProbe,
  GatewaySessionInput,
  GatewaySettings,
  PaymentEvent,
  PaymentGateway,
} from "./port";

/** An app provider id: the fake joins a request's providers the way an app does. */
export const FAKE_GATEWAY_ID = "acme.fake:pay";

export interface FakeGatewaySettings extends GatewaySettings {
  apiKey: string;
}

export interface FakeGatewayState {
  settings: FakeGatewaySettings | null;
  sessions: GatewaySessionInput[];
  refunds: Array<{ amountMinor: number; currency: string; idempotencyKey: string; secondaryRef: string | null }>;
  /** Next refund call throws this (an unknown provider outcome) when set. */
  refundError: Error | null;
  refundStatus: GatewayRefundProbe;
  providerRefunds: GatewayProviderRefund[];
}

export function createFakeGateway(id = FAKE_GATEWAY_ID): {
  gateway: PaymentGateway<FakeGatewaySettings>;
  state: FakeGatewayState;
  /** The built-in gateways plus this one: what a request with the app installed sees. */
  providers: PaymentProviders;
} {
  const state: FakeGatewayState = {
    settings: { enabled: true, apiKey: "live_key" },
    sessions: [],
    refunds: [],
    refundError: null,
    refundStatus: { outcome: "accepted", providerStatus: "refunded" },
    providerRefunds: [],
  };

  const gateway: PaymentGateway<FakeGatewaySettings> = {
    id,
    label: "FakePay",
    checkoutName: "FakePay wallet",
    flow: "hosted",
    chargeCurrencies: ["BDT"],
    amountLimits: { currency: "BDT", minMinor: 1_000, maxMinor: 10_000_000 },
    supportsRefund: true,

    loadSettings: async () => state.settings,
    readiness(settings) {
      const missingFields = settings?.apiKey ? [] : ["apiKey"];
      const credentialErrors = [
        ...(settings?.credentialErrors ?? []),
        ...(settings?.apiKey === "dummy" ? ["FakePay API key looks like a placeholder."] : []),
      ];
      const configured = missingFields.length === 0 && credentialErrors.length === 0;
      const enabled = settings?.enabled === true;
      return {
        configured,
        enabled,
        usable: configured && enabled,
        missingFields,
        credentialErrors,
        blockedReason: credentialErrors[0] ?? (missingFields.length ? "FakePay needs an API key." : undefined),
      };
    },
    canVerify: (settings) => Boolean(settings.apiKey),
    environment: () => "test",
    publicConfig: () => ({ testMode: true }),

    async createSession(input) {
      state.sessions.push(input);
      return { providerRef: `fs_${input.attemptKey.slice(-8)}`, redirectUrl: `https://pay.fake.test/${input.correlationId}` };
    },

    // The "signature" is a shared-secret header; the body is the normalized event.
    async verifyWebhook(request, { settings }) {
      if (request.headers["x-fake-signature"] !== settings.apiKey) return { status: "invalid", reason: "bad signature" };
      return { status: "event", event: JSON.parse(request.rawBody) as PaymentEvent };
    },
    async verifyReturn(request, call) {
      return gateway.verifyWebhook(request, call);
    },
    returnCorrelationId: (request) => new URLSearchParams(request.rawBody).get("tran_id") ?? "",

    async refund(input) {
      if (!input.secondaryRef) throw new ValidationError("No FakePay transaction reference on payment record");
      state.refunds.push({
        amountMinor: input.amountMinor,
        currency: input.currency,
        idempotencyKey: input.idempotencyKey,
        secondaryRef: input.secondaryRef,
      });
      if (state.refundError) {
        const error = state.refundError;
        state.refundError = null;
        throw error;
      }
      return { refundId: `fr_${state.refunds.length}` };
    },
    refundStatus: async () => state.refundStatus,
    listRefunds: async () => state.providerRefunds,
  };
  return { gateway, state, providers: createPaymentProviders([gateway]) };
}

/** The Bangladesh pack's SSLCommerz provider id (`sslcommerz` on orders made before it moved there). */
export const PACK_SSLCOMMERZ_ID = "scalius.bangladesh:sslcommerz";

/**
 * A request's gateways with the Bangladesh pack's SSLCommerz active: a fake
 * hosted gateway under its id, with its declared name and BDT limits (10 to
 * 500,000 taka). Orders that still name `sslcommerz` resolve to it.
 */
export function createSslcommerzPackProviders(): { gateway: PaymentGateway<FakeGatewaySettings>; state: FakeGatewayState; providers: PaymentProviders } {
  const fake = createFakeGateway(PACK_SSLCOMMERZ_ID);
  const gateway: PaymentGateway<FakeGatewaySettings> = {
    ...fake.gateway,
    label: "SSLCommerz",
    amountLimits: { currency: "BDT", minMinor: 1_000, maxMinor: 50_000_000 },
  };
  return { gateway, state: fake.state, providers: createPaymentProviders([gateway]) };
}
