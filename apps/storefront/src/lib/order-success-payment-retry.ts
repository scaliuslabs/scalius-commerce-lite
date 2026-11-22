import type { GatewayConfig } from "./api/checkout";
import type { CustomerPaymentRecovery } from "./api/customer-auth";
import type { BuyerOrderDetailView } from "@scalius/shared/buyer-order-view";
import type { OrderSuccessStateKind } from "./order-success-state";
import { GIFT_CARD_PAYMENT_METHOD, RECORDED_PAYMENT_METHOD } from "./order-success-state";
import { appGatewayName } from "./checkout/gateway-presentation";
import { isPaymentMethodIdShape } from "./payment-method-id";

export type OrderSuccessRetryPaymentType = "full" | "deposit" | "balance";
/** An online gateway id (every payment method except "cod"). */
export type OrderSuccessRetryGateway = string;
export type OrderSuccessRetryOption = {
  gateway: OrderSuccessRetryGateway;
  /** The store's or app's name for the method; the page names a built-in one in its own copy. */
  label: string;
  endpoint: string;
  current: boolean;
  requiresCardForm: boolean;
};

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function retryEndpoint(gateway: string): string {
  return `/api/checkout/payment-session/${gateway}`;
}

/**
 * A gateway id that can be retried: never cash on delivery, never
 * `gift_card` (the order's cards paid in full at commit; nothing to collect),
 * and never `manual` (paid as it was placed, to the store).
 */
function normalizeHostedGateway(value: string | null | undefined): OrderSuccessRetryGateway | null {
  const method = normalize(value);
  return isPaymentMethodIdShape(method) && method !== "cod" && method !== GIFT_CARD_PAYMENT_METHOD
    && method !== RECORDED_PAYMENT_METHOD
    ? method
    : null;
}

/**
 * The receipt's retry buttons: only for a payment that is pending or failed
 * (`buyerView.paymentAction === "retry"`; paying a placed order's balance
 * early is never offered as a retry here), and only the methods the server
 * says a session would be accepted for. The method it starts first comes
 * first; after a failed payment the others follow.
 */
export function getOrderSuccessRetryOptions(
  order: { buyerView: Pick<BuyerOrderDetailView, "paymentAction">; paymentRecovery: Pick<CustomerPaymentRecovery, "gateway" | "gateways"> | null },
  stateKind: OrderSuccessStateKind,
  gateways: (Pick<GatewayConfig, "id"> & Partial<Pick<GatewayConfig, "name">>)[],
): OrderSuccessRetryOption[] {
  const recovery = order.paymentRecovery;
  if (order.buyerView.paymentAction !== "retry" || !recovery) return [];
  const currentGateway = normalizeHostedGateway(recovery.gateway);
  if (!currentGateway) return [];
  const accepted = new Set(recovery.gateways);
  const allowAlternates = stateKind === "payment_issue";

  return [...new Set(gateways.map((gateway) => normalizeHostedGateway(gateway.id)))]
    .filter((gateway): gateway is OrderSuccessRetryGateway => gateway !== null && accepted.has(gateway))
    .filter((gateway) => gateway === currentGateway || allowAlternates)
    .map((gateway) => ({
      gateway,
      endpoint: retryEndpoint(gateway),
      current: gateway === currentGateway,
      // An app's wallet reads by the checkout name the store serves, never its id;
      // a built-in method by the page's copy (`getGatewayPresentation`).
      label: appGatewayName(gateway, gateways) ?? gateway,
      requiresCardForm: gateway === "stripe",
    }));
}

export function normalizeRetryDepositAmount(value: string | null | undefined): number | null {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}
