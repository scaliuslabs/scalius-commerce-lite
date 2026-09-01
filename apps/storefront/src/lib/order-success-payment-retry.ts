import type { OrderReceipt } from "./api/types";
import type { GatewayConfig } from "./api/checkout";
import type { OrderSuccessStateKind } from "./order-success-state";
import { getOrderSuccessVisibleBalanceDue } from "./order-success-state";
import { getGatewayPresentation } from "./checkout/gateway-presentation";

export type OrderSuccessRetryPaymentType = "full" | "deposit" | "balance";
export type OrderSuccessRetryGateway = "stripe" | "sslcommerz" | "polar";
export type OrderSuccessRetryOption = {
  gateway: OrderSuccessRetryGateway;
  label: string;
  endpoint: string;
  current: boolean;
  requiresCardForm: boolean;
};

const RETRYABLE_HOSTED_METHODS = new Set(["stripe", "sslcommerz", "polar"]);
const RETRYABLE_CALLBACK_RESULTS = new Set(["failed", "cancelled"]);
const PAYMENT_BLOCKED_ORDER_STATUSES = new Set([
  "cancelled",
  "returned",
  "refunded",
  "partially_refunded",
]);
const PAYMENT_BLOCKED_PAYMENT_STATUSES = new Set(["paid", "refunded"]);
function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function isRetryableHostedPaymentMethod(paymentMethod: string | null | undefined): boolean {
  return RETRYABLE_HOSTED_METHODS.has(normalize(paymentMethod));
}

export function getOrderSuccessRetryEndpoint(paymentMethod: string | null | undefined): string | null {
  const method = normalize(paymentMethod);
  if (method === "stripe") return "/api/checkout/stripe-intent";
  if (method === "sslcommerz") return "/api/checkout/sslcommerz-session";
  if (method === "polar") return "/api/checkout/polar-session";
  return null;
}

export function isHostedPaymentRetryResult(result: string | null | undefined): boolean {
  return RETRYABLE_CALLBACK_RESULTS.has(normalize(result));
}

export function canRetryOrderSuccessPayment(
  order: Pick<
    OrderReceipt,
    "paymentMethod" | "status" | "paymentStatus" | "totalAmount" | "paidAmount" | "balanceDue"
  >,
  stateKind: OrderSuccessStateKind,
  callbackResult: string | null | undefined,
): boolean {
  if (!isRetryableHostedPaymentMethod(order.paymentMethod)) return false;
  if (PAYMENT_BLOCKED_ORDER_STATUSES.has(normalize(order.status))) return false;
  if (PAYMENT_BLOCKED_PAYMENT_STATUSES.has(normalize(order.paymentStatus))) return false;
  if (getOrderSuccessVisibleBalanceDue(order) <= 0) return false;
  void callbackResult;
  return stateKind === "payment_pending" || stateKind === "payment_issue";
}

function normalizeHostedGateway(value: string | null | undefined): OrderSuccessRetryGateway | null {
  const method = normalize(value);
  return method === "stripe" || method === "sslcommerz" || method === "polar" ? method : null;
}

export function getOrderSuccessRetryOptions(
  order: Pick<
    OrderReceipt,
    "paymentMethod" | "status" | "paymentStatus" | "totalAmount" | "paidAmount" | "balanceDue"
  >,
  stateKind: OrderSuccessStateKind,
  callbackResult: string | null | undefined,
  gateways: Pick<GatewayConfig, "id">[],
): OrderSuccessRetryOption[] {
  if (!canRetryOrderSuccessPayment(order, stateKind, callbackResult)) return [];

  const currentGateway = normalizeHostedGateway(order.paymentMethod);
  if (!currentGateway) return [];

  const visibleHostedGateways = gateways
    .map((gateway) => normalizeHostedGateway(gateway.id))
    .filter((gateway): gateway is OrderSuccessRetryGateway => gateway !== null);
  const visibleUniqueGateways = [...new Set(visibleHostedGateways)];
  const allowAlternates = stateKind === "payment_issue";

  return visibleUniqueGateways
    .filter((gateway) => gateway === currentGateway || allowAlternates)
    .map((gateway) => {
      const current = gateway === currentGateway;
      return {
        gateway,
        endpoint: getOrderSuccessRetryEndpoint(gateway) ?? "",
        current,
        label: getGatewayPresentation(gateway, gateway).buyerLabel,
        requiresCardForm: gateway === "stripe",
      };
    })
    .filter((option) => option.endpoint);
}

export function resolveOrderSuccessRetryPaymentType(
  order: Pick<OrderReceipt, "paymentStatus" | "paidAmount" | "balanceDue">,
  requestedType: string | null | undefined,
): OrderSuccessRetryPaymentType {
  const requested = normalize(requestedType);
  if (requested === "deposit" || requested === "balance" || requested === "full") {
    return requested;
  }

  const paidAmount = Number(order.paidAmount ?? 0);
  const balanceDue = Number(order.balanceDue ?? 0);
  const paymentStatus = normalize(order.paymentStatus);
  if (paymentStatus === "partial" || (paidAmount > 0 && balanceDue > 0)) {
    return "balance";
  }

  return "full";
}

export function normalizeRetryDepositAmount(value: string | null | undefined): number | null {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}
