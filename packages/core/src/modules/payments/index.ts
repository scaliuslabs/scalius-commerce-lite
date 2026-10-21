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
  isManualSettlementMethod,
  isOnlinePaymentMethod,
  isPaymentMethodId,
  NET_TERMS_LABEL,
  NET_TERMS_PAYMENT_METHOD,
  onlinePaymentMethodCondition,
  paymentMethodLabel,
  RECORDED_PAYMENT_METHOD,
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
export { recordOrderPayment, type RecordedPaymentLine, type RecordOrderPaymentInput, type RecordOrderPaymentResult } from "./recorded-payment";

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

// --- Saved payment methods, off-session charges, authorizations ---
export { processPaymentAuthorized, releaseAuthorization } from "./process-payment";
export {
  buildSavedPaymentMethodUpsert,
  CUSTOMER_PAYMENT_METHODS_LIST_LIMIT,
  listCustomerPaymentMethods,
  removeCustomerPaymentMethod,
  type CustomerPaymentMethodView,
} from "./saved-payment-methods";
export {
  captureAuthorizedPayment,
  chargeSavedPaymentMethod,
  voidAuthorizedPayment,
  type AppliedPaymentEventStatus,
  type ApplyProviderPaymentEvent,
  type ChargeSavedPaymentMethodInput,
  type SavedMethodPaymentOutcome,
} from "./saved-method-charges";
export type {
  ComputedOrderPaymentState,
  ComputePaymentStateInput,
} from "./payment-state";

// --- Refund service ---
export { finalizeAcceptedRefundAttemptIds, processRefund, STORE_CREDIT_NEEDS_STAFF_REASON } from "./refund-service";
export type {
  FinalizeAcceptedRefundAttemptsResult,
  RefundCaller,
  RefundLineInput,
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
