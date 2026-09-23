// Stripe adapter: card flow (PaymentIntents confirmed in the browser),
// signed webhooks, charge refunds. Stripe SDK v17+ uses fetch natively.

import Stripe from "stripe";
import { ValidationError } from "@scalius/core/errors";
import { getStripeCredentialEnvironment } from "@scalius/shared/payment-gateway-environment";
import {
  getStripeCheckoutReadiness,
  getStripeSettings,
  type StripeSettings,
} from "../gateway-settings";
import {
  PaymentProviderError,
  isProviderTimeoutError,
  type GatewayProviderRefund,
  type GatewayRefundProbe,
  type PaymentEvent,
  type PaymentGateway,
  type PaymentType,
} from "./port";

function stripeClient(secretKey: string): Stripe {
  // The client holds credentials and transport state: keep it per request.
  return new Stripe(secretKey);
}

function providerError(error: unknown, fallback: string): PaymentProviderError {
  if (isProviderTimeoutError(error)) {
    return new PaymentProviderError("Stripe did not respond before the payment timeout. Please try again.", { timedOut: true });
  }
  return new PaymentProviderError(error instanceof Stripe.errors.StripeError ? error.message : fallback);
}

function paymentTypeOf(metadata: Record<string, string> | null | undefined): PaymentType | undefined {
  const value = metadata?.paymentType;
  return value === "full" || value === "deposit" || value === "balance" ? value : undefined;
}

function idOf(value: string | { id?: string } | null | undefined): string | undefined {
  return typeof value === "string" ? value : value?.id ?? undefined;
}

function confirmedEvent(intent: Stripe.PaymentIntent, eventType: string, eventId: string): PaymentEvent | null {
  const orderId = intent.metadata?.orderId;
  if (!orderId) return null;
  return {
    kind: "confirmed",
    eventType,
    eventId,
    orderId,
    providerRef: intent.id,
    secondaryRef: idOf(intent.latest_charge),
    amountMinor: intent.amount_received,
    currency: intent.currency.toUpperCase(),
    paymentType: paymentTypeOf(intent.metadata),
  };
}

function toEvent(event: Stripe.Event): PaymentEvent | null {
  switch (event.type) {
    case "payment_intent.succeeded":
      return confirmedEvent(event.data.object, event.type, event.id);
    case "payment_intent.payment_failed":
    case "payment_intent.canceled": {
      const intent = event.data.object;
      if (!intent.metadata?.orderId) return null;
      return {
        kind: event.type === "payment_intent.canceled" ? "cancelled" : "failed",
        eventType: event.type,
        eventId: event.id,
        orderId: intent.metadata.orderId,
        providerRef: intent.id,
        details: {
          failureCode: intent.last_payment_error?.code ?? null,
          failureMessage: intent.last_payment_error?.message ?? null,
        },
      };
    }
    case "charge.refunded": {
      const charge = event.data.object;
      const paymentIntentId = idOf(charge.payment_intent);
      if (!charge.metadata?.orderId || !paymentIntentId) return null;
      return {
        kind: "refund_observed",
        eventType: event.type,
        eventId: event.id,
        orderId: charge.metadata.orderId,
        providerRef: paymentIntentId,
        secondaryRef: charge.id,
        details: { amountRefunded: charge.amount_refunded, currency: charge.currency.toUpperCase() },
      };
    }
    default:
      return null;
  }
}

function refundOf(refund: Stripe.Refund): GatewayProviderRefund {
  return {
    id: refund.id,
    succeeded: refund.status === "succeeded",
    amountMinor: refund.amount,
    currency: refund.currency.toUpperCase(),
    sourceRef: idOf(refund.charge) ?? null,
    status: refund.status,
  };
}

function refundMatchesAttempt(refund: Stripe.Refund, input: { reference: string; idempotencyKey: string }): boolean {
  const metadata = refund.metadata ?? {};
  return metadata.refundReference === input.reference ||
    metadata.providerIdempotencyKey === input.idempotencyKey ||
    metadata.idempotencyKey === input.idempotencyKey;
}

export const stripeGateway: PaymentGateway<StripeSettings> = {
  id: "stripe",
  label: "Stripe",
  checkoutName: "Card Payment",
  flow: "card",
  currencies: "any",
  supportsRefund: true,

  loadSettings: getStripeSettings,
  readiness: getStripeCheckoutReadiness,
  canVerify: (settings) => Boolean(settings.secretKey && settings.webhookSecret),
  environment: (settings) => getStripeCredentialEnvironment(settings),
  publicConfig: (settings) => ({
    publishableKey: settings.publishableKey.trim(),
    testMode: getStripeCredentialEnvironment(settings) === "test",
  }),

  async createSession(settings, input) {
    try {
      const intent = await stripeClient(settings.secretKey).paymentIntents.create({
        amount: input.amountMinor,
        currency: input.currency.toLowerCase(),
        capture_method: "automatic",
        metadata: { orderId: input.orderId, paymentType: input.paymentType },
      }, {
        idempotencyKey: input.attemptKey,
        timeout: input.requestTimeoutMs,
        maxNetworkRetries: 0,
      });
      return {
        providerRef: intent.id,
        clientSecret: intent.client_secret ?? undefined,
        publishableKey: settings.publishableKey,
      };
    } catch (error) {
      throw providerError(error, "Failed to create payment intent");
    }
  },

  async verifyWebhook(settings, request) {
    let event: Stripe.Event;
    try {
      event = await stripeClient(settings.secretKey).webhooks.constructEventAsync(
        request.rawBody,
        request.headers.get("stripe-signature") ?? "",
        settings.webhookSecret,
      );
    } catch {
      return { status: "invalid", reason: "Invalid signature" };
    }
    const normalized = toEvent(event);
    return normalized
      ? { status: "event", event: normalized }
      : { status: "ignored", reason: `Unhandled Stripe event ${event.type}` };
  },

  async query(settings, input, requestTimeoutMs) {
    let intent: Stripe.PaymentIntent;
    try {
      intent = await stripeClient(settings.secretKey).paymentIntents.retrieve(
        input.providerRef,
        {},
        { timeout: requestTimeoutMs },
      );
    } catch (error) {
      throw providerError(error, "Failed to retrieve Stripe payment intent");
    }
    if (intent.id !== input.providerRef || intent.metadata?.orderId !== input.orderId) {
      throw new ValidationError("Stripe payment verification did not match this order.");
    }
    if (intent.status !== "succeeded") return { providerStatus: intent.status };
    return {
      providerStatus: intent.status,
      event: confirmedEvent(intent, "payment_intent.succeeded", `buyer-reconcile:${intent.id}`) ?? undefined,
    };
  },

  async refund(settings, input) {
    if (!input.secondaryRef) throw new ValidationError("No Stripe charge ID found on payment record");
    const reason = input.reason === "duplicate" || input.reason === "fraudulent"
      ? input.reason
      : "requested_by_customer";
    try {
      const refund = await stripeClient(settings.secretKey).refunds.create({
        charge: input.secondaryRef,
        amount: input.amountMinor,
        reason,
        metadata: input.metadata,
      }, { idempotencyKey: input.idempotencyKey });
      return { refundId: refund.id };
    } catch (error) {
      throw providerError(error, "Failed to create refund");
    }
  },

  async refundStatus(settings, input): Promise<GatewayRefundProbe> {
    const stripe = stripeClient(settings.secretKey);
    let refund: Stripe.Refund | undefined;
    try {
      if (input.providerRefundId) {
        refund = await stripe.refunds.retrieve(input.providerRefundId);
      } else if (input.sourceRef) {
        const listed = await stripe.refunds.list({ charge: input.sourceRef, limit: 20 });
        refund = listed.data.find((candidate) =>
          refundMatchesAttempt(candidate, input) &&
          candidate.currency.toUpperCase() === input.currency &&
          candidate.amount === input.amountMinor
        );
      }
    } catch (error) {
      return { outcome: "unknown", error: error instanceof Error ? error.message : "Stripe refund probe failed" };
    }

    if (!refund) {
      return { outcome: "unknown", error: "No Stripe refund matched this attempt. Manual review required before retrying.", manualReview: true };
    }
    const payload = { id: refund.id, status: refund.status, amount: refund.amount, currency: refund.currency, charge: idOf(refund.charge) ?? null };
    if (input.sourceRef && payload.charge !== input.sourceRef) {
      return { outcome: "unknown", providerRefundId: refund.id, providerStatus: refund.status ?? "unknown", error: "Stripe refund source charge does not match the local refund attempt.", manualReview: true };
    }
    if (refund.currency.toUpperCase() !== input.currency) {
      return { outcome: "unknown", error: "Stripe refund currency does not match the immutable order currency.", manualReview: true };
    }
    if (refund.amount !== input.amountMinor) {
      return { outcome: "unknown", providerRefundId: refund.id, providerStatus: refund.status ?? "unknown", error: "Stripe refund amount does not match the immutable local refund attempt.", responsePayload: payload, manualReview: true };
    }
    if (refund.status === "succeeded") {
      return { outcome: "accepted", providerRefundId: refund.id, providerStatus: refund.status, responsePayload: payload };
    }
    if (refund.status === "failed" || refund.status === "canceled") {
      return { outcome: "rejected", providerRefundId: refund.id, providerStatus: refund.status, responsePayload: payload };
    }
    const pending = refund.status === "pending" || refund.status === "requires_action";
    return { outcome: pending ? "processing" : "unknown", providerRefundId: refund.id, providerStatus: refund.status ?? "unknown", responsePayload: payload };
  },

  async listRefunds(settings, sourceRef) {
    const listed = await stripeClient(settings.secretKey).refunds.list({ charge: sourceRef, limit: 100 });
    return listed.data.map(refundOf);
  },
};
