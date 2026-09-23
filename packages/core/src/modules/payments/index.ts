// src/modules/payments/index.ts
// Barrel exports for the payments module. Gateway adapters live in
// ./gateways (port.ts, one file per provider, registry.ts).

export type { PaymentType, PaymentResult, ProcessPaymentParams } from "./types";
export type {
  GatewayCheckoutFlow,
  GatewayReadiness,
  PaymentEvent,
  PaymentGateway,
} from "./gateways/port";
export {
  COD_PAYMENT_METHOD,
  getPaymentGateway,
  isOnlinePaymentMethod,
  isPaymentMethodId,
  listPaymentGateways,
  listPaymentMethodIds,
  paymentMethodLabel,
  requirePaymentGateway,
} from "./gateways/registry";

// --- Gateway settings ---
export {
  getStripeSettings,
  getSSLCommerzSettings,
  getActivePaymentMethods,
} from "./gateway-settings";
export type {
  StripeSettings,
  SSLCommerzSettings,
  PaymentMethodsConfig,
} from "./gateway-settings";

export { initCODTracking, recordCODCollection, recordCODFailure, markCODReturned } from "./cod";

// --- Payment processing ---
export { processPaymentConfirmed, processPaymentFailed, releaseOrderInventory } from "./process-payment";
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
  ACTIVE_REFUND_ATTEMPT_STATUSES,
  ORDER_REFUND_MUTATION_BLOCKED_MESSAGE,
  REFUND_IN_PROGRESS_MESSAGE,
  assertNoActiveRefundAttempt,
  assertNoActiveRefundAttemptsForOrders,
  findActiveRefundAttempt,
  findActiveRefundAttemptsForOrders,
  noActiveRefundAttemptForOrderColumnCondition,
  noActiveRefundAttemptForOrderIdCondition,
} from "./refund-attempt-guard";
export type {
  ActiveRefundAttemptSnapshot,
  ActiveRefundAttemptStatus,
} from "./refund-attempt-guard";
export {
  formatRefundAttemptForVisibility,
  listOrderRefundAttempts,
  summarizeActiveRefundOperation,
} from "./refund-attempt-visibility";
export type {
  ActiveRefundOperationView,
  OrderRefundAttemptView,
  RefundAttemptVisibilityRow,
} from "./refund-attempt-visibility";

// --- Public payment session attempts ---
export {
  ACTIVE_PAYMENT_SESSION_SETUP_MESSAGE,
  activePaymentSessionAttemptExistsCondition,
  assertNoActivePaymentSessionAttempt,
  assertNoActivePaymentSessionAttemptsForOrders,
  buildPaymentSessionAttemptIdentity,
  claimPaymentSessionAttempt,
  listOrderPaymentSessionAttempts,
  markPaymentSessionAttemptCreated,
  markPaymentSessionAttemptFailed,
  noActivePaymentSessionAttemptForOrderIdCondition,
  noActivePaymentSessionAttemptForOrderSqlCondition,
} from "./payment-session-attempts";
export type {
  AdminPaymentSessionAttemptView,
  PaymentSessionAttemptIdentity,
  ClaimPaymentSessionAttemptInput,
  ClaimedPaymentSessionAttempt,
  PaymentSessionAttemptClaimResult,
} from "./payment-session-attempts";
