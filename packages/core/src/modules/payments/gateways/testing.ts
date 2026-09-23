// Test-only: a complete hosted gateway adapter with no provider behind it.
// Registering it is the proof that a new gateway needs one adapter plus one
// registry line. Never import this from Worker code.

import { ValidationError } from "@scalius/core/errors";
import { PAYMENT_GATEWAYS } from "./registry";
import type {
  GatewayProviderRefund,
  GatewayRefundProbe,
  GatewaySessionInput,
  GatewaySettings,
  PaymentEvent,
  PaymentGateway,
} from "./port";

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

export function createFakeGateway(id = "fakepay"): { gateway: PaymentGateway<FakeGatewaySettings>; state: FakeGatewayState } {
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
    currencies: ["BDT"],
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

    async createSession(_settings, input) {
      state.sessions.push(input);
      return { providerRef: `fs_${input.attemptKey.slice(-8)}`, redirectUrl: `https://pay.fake.test/${input.correlationId}` };
    },

    // The "signature" is a shared-secret header; the body is the normalized event.
    async verifyWebhook(settings, request) {
      if (request.headers.get("x-fake-signature") !== settings.apiKey) return { status: "invalid", reason: "bad signature" };
      return { status: "event", event: JSON.parse(request.rawBody) as PaymentEvent };
    },
    async verifyReturn(settings, request) {
      return this.verifyWebhook(settings, request);
    },
    returnCorrelationId: (request) => new URLSearchParams(request.rawBody).get("tran_id") ?? "",

    async refund(_settings, input) {
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
  return { gateway, state };
}

/** Register the fake adapter (the one registry line) and return its handle plus an unregister function. */
export function registerFakeGateway(id = "fakepay") {
  const fake = createFakeGateway(id);
  PAYMENT_GATEWAYS[id] = fake.gateway as PaymentGateway;
  return { ...fake, unregister: () => { delete PAYMENT_GATEWAYS[id]; } };
}
