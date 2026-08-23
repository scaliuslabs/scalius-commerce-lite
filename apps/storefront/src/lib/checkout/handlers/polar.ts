import type { GatewayHandler, PaymentContext, PaymentResult } from "../types";
import { CheckoutOrderError, createOrder } from "../create-order";
import { resolveCheckoutPaymentRequest, resolveExplicitCheckoutPaymentRequest } from "../payment-mode";
import { buildPaymentRecoveryUrl } from "../payment-recovery";
import { fetchPaymentSessionWithProcessingRetry } from "../payment-session-retry";
import { normalizeHostedCheckoutUrl } from "../redirect-url";

export const polarHandler: GatewayHandler = {
  id: "polar",
  meta: {
    label: "International card & Cash App",
    icon: `<svg class="w-6 h-6 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M13 10V3L4 14h7v7l9-11h-7z" />
    </svg>`,
    desc: "Cards and Cash App",
  },

  getButtonText(_isPartialPayment: boolean): string {
    return "Continue to Payment \u2192";
  },

  async processPayment(ctx: PaymentContext): Promise<PaymentResult> {
    let createdOrder: Awaited<ReturnType<typeof createOrder>> | null = null;
    let paymentRequest: ReturnType<typeof resolveCheckoutPaymentRequest> | null = null;
    try {
      createdOrder = ctx.orderId
        ? { orderId: ctx.orderId, totalAmount: ctx.totalAmount }
        : await createOrder(ctx.checkoutData, "polar");
      const { orderId } = createdOrder;
      paymentRequest = ctx.paymentType
        ? resolveExplicitCheckoutPaymentRequest(ctx.paymentType, ctx.depositAmount)
        : resolveCheckoutPaymentRequest(ctx.config, createdOrder.totalAmount ?? ctx.totalAmount);

      let gatewayUrl = createdOrder.initialPaymentSession?.gateway === "polar"
        ? createdOrder.initialPaymentSession.gatewayUrl
        : undefined;

      if (!gatewayUrl && createdOrder.initialPaymentSessionError) {
        throw new Error(createdOrder.initialPaymentSessionError);
      }

      if (!gatewayUrl) {
        const sessionPayload: Record<string, unknown> = {
          orderId,
          ...(ctx.orderId
            ? {
                paymentType: ctx.paymentType,
                ...(ctx.paymentType === "deposit" && ctx.depositAmount
                  ? { depositAmount: ctx.depositAmount }
                  : {}),
                replaceExistingAttempt: ctx.replaceExistingAttempt ?? true,
              }
            : {}),
        };

        const { data: sessionData, response: sessionRes } = await fetchPaymentSessionWithProcessingRetry(() => fetch("/api/checkout/polar-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sessionPayload),
        }));

        if (!sessionRes.ok) {
          const e = sessionData;
          throw new Error((e.error as string) || "Payment gateway initialization failed");
        }
        gatewayUrl = typeof sessionData.gatewayUrl === "string" ? sessionData.gatewayUrl : undefined;
      }
      gatewayUrl = normalizeHostedCheckoutUrl(gatewayUrl) ?? undefined;
      if (!gatewayUrl) throw new Error("Payment gateway returned an unsafe checkout URL");
      const hostedPaymentRecoveryUrl = buildPaymentRecoveryUrl({
        orderId,
        gateway: "polar",
        paymentType: paymentRequest?.paymentType,
        depositAmount: paymentRequest?.paymentType === "deposit" ? paymentRequest.depositAmount : undefined,
      });

      return {
        success: true,
        redirectUrl: gatewayUrl,
        hostedPaymentRecoveryUrl,
      };
    } catch (err: unknown) {
      if (createdOrder) {
        const hostedPaymentRecoveryUrl = buildPaymentRecoveryUrl({
          orderId: createdOrder.orderId,
          gateway: "polar",
          paymentType: paymentRequest?.paymentType,
          depositAmount: paymentRequest?.paymentType === "deposit" ? paymentRequest.depositAmount : undefined,
        });
        return {
          success: true,
          redirectUrl: hostedPaymentRecoveryUrl,
          hostedPaymentRecoveryUrl,
        };
      }
      if (err instanceof CheckoutOrderError) {
        return {
          success: false,
          error: err.message,
          errorCode: err.errorCode,
          status: err.status,
          cartIssues: err.cartIssues,
        };
      }
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
