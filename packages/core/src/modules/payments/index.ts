// Barrel exports for the payments module. Gateway adapters live in
// ./gateways (port.ts, one file per built-in provider, registry.ts).
export * from "./browser";
export * from "./gateways/port";
export * from "./gateways/correlation";
export * from "./payable-order";
export * from "./payment-state";

export type { PaymentType, PaymentResult, ProcessPaymentParams } from "./types";
export type {
  GatewayCheckoutFlow,
  GatewayReadiness,
  PaymentEvent,
  PaymentGateway,
} from "./gateways/port";
export {
  BUILT_IN_PAYMENT_GATEWAY_IDS,
  BUILT_IN_PAYMENT_PROVIDERS,
  CASH_ON_DELIVERY_AMOUNT_REASON,
  COD_PAYMENT_METHOD,
  createPaymentProviders,
  isAppPaymentMethod,
  isOnlinePaymentMethod,
  isPaymentMethodId,
  onlinePaymentMethodCondition,
  paymentMethodLabel,
  paymentProvidersFor,
} from "./gateways/registry";
export type { CheckoutGatewayPrecommitInput, PaymentProviders, PaymentProvidersSource } from "./gateways/registry";

// --- Gateway settings ---
export {
  getStripeSettings,
  getActivePaymentMethods,
} from "./gateway-settings";
export type {
  StripeSettings,
  PaymentMethodsConfig,
} from "./gateway-settings";

export { recordCODCollection, recordCODFailure, markCODReturned } from "./cod";

// --- Payment processing ---
export { processPaymentConfirmed, processPaymentFailed, type PaymentFailureEvent } from "./process-payment";
export {
  assertOrderPaymentCurrency,
  createOrderCurrencySnapshot,
  resolveOrderCurrencySnapshot,
} from "./order-currency";
export type {
  OrderCurrencySnapshot,
  OrderCurrencySnapshotSource,
} from "./order-currency";
export {
  computeOrderPaymentState,
  computePaymentStateAfterPayment,
} from "./payment-state";
export type {
  ComputedOrderPaymentState,
  ComputePaymentStateInput,
} from "./payment-state";

// --- Refund service ---
export { finalizeAcceptedRefundAttemptIds, processRefund } from "./refund-service";
export type {
  FinalizeAcceptedRefundAttemptsResult,
  RefundNotificationFact,
  RefundRequest,
  RefundResult as RefundServiceResult,
} from "./refund-service";
export {
  reconcileDueRefundAttempts,
  reconcileExternalRefundWebhooks,
  reconcileRefundAttemptForOrder,
  reconcileRefundAttemptById,
} from "./refund-reconciliation";
export type {
  ExternalRefundWebhookReconciliationOptions,
  ExternalRefundWebhookReconciliationResult,
  ManualRefundAttemptReconciliationReason,
  ManualRefundAttemptReconciliationResult,
  RefundReconciliationOptions,
  RefundReconciliationResult,
} from "./refund-reconciliation";
export {
  formatRefundAttemptForVisibility,
  listOrderRefundAttempts,
  summarizeActiveRefundOperation,
} from "./refund-attempt-visibility";
export type { RefundAttemptVisibilityRow } from "./refund-attempt-visibility";

// --- Public payment session attempts ---
export {
  buildPaymentSessionAttemptIdentity,
  claimPaymentSessionAttempt,
  listOrderPaymentSessionAttempts,
  markPaymentSessionAttemptCreated,
  markPaymentSessionAttemptFailed,
} from "./payment-session-attempts";
export type {
  AdminPaymentSessionAttemptView,
  PaymentSessionAttemptIdentity,
  ClaimPaymentSessionAttemptInput,
  ClaimedPaymentSessionAttempt,
  PaymentSessionAttemptClaimResult,
} from "./payment-session-attempts";
export { PartialRefundProcessedError } from "./refund-service";
export {
  getPaymentGatewaySettingsSnapshot,
  getPaymentMethodPreferences,
  getStripeCheckoutReadiness,
  resolveActivePaymentMethodsFromRows,
  resolveAppPaymentUsability,
} from "./gateway-settings";
export type { AppPaymentUsability, GatewaySettingsStoredRow } from "./gateway-settings";
export { COD_COUNTRIES, COD_LABEL, getGatewayAmountIssue, publicAmountLimits } from "./gateways/registry";
export { REFUND_OBSERVED_EVENT_TYPE } from "./refund-reconciliation";
export { reconcileHostedPaymentReturn } from "./hosted-payment-return";
export type { HostedPaymentReturnResult } from "./hosted-payment-return";
export type { PaymentSessionAttemptProcessingResult } from "./payment-session-attempts";
export { createCODTrackingInsertValues, toCashOnDeliveryMinor, validateCODCollectionDetails } from "./cod";
export { resolveActiveRefundOperationsForOrders, selectActiveRefundAttemptRowsForOrders } from "./refund-attempt-visibility";
