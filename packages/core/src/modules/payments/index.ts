// src/modules/payments/index.ts
// Barrel exports for the payments module.

// --- Provider interface & types ---
export type {
  PaymentProvider,
  CreatePaymentParams,
  CreatePaymentResult,
  RefundParams,
  RefundResult,
  WebhookPayload,
} from "./provider";

// --- Factory ---
export { createPaymentProvider } from "./factory";
export type { GatewayConfig } from "./factory";

// --- Provider implementations ---
export { StripeProvider } from "./stripe";
export { SSLCommerzProvider } from "./sslcommerz";
export { PolarProvider } from "./polar";
export { CODProvider } from "./cod";

// --- Domain types ---
export type {
  PaymentGateway,
  PaymentType,
  PaymentResult,
  CreateStripePaymentIntentParams,
  StripePaymentIntentResult,
  InitSSLCommerzSessionParams,
  SSLCommerzSessionResult,
  SSLCommerzIPNPayload,
  SSLCommerzValidationResult,
  CreatePolarCheckoutParams,
  PolarCheckoutResult,
  PolarRefundParams,
  PolarRefundResult,
  InitCODTrackingParams,
  RecordCODCollectionParams,
  RecordCODFailureParams,
  ProcessPaymentParams,
} from "./types";

// --- Gateway registry ---
export {
  registerGateway,
  getRegisteredGateways,
  getGatewayMeta,
} from "./gateway-registry";
export type { GatewayMeta } from "./gateway-registry";

// --- Gateway settings ---
export {
  getStripeSettings,
  getSSLCommerzSettings,
  getPolarSettings,
  getActivePaymentMethods,
  upsertSetting,
  upsertEncryptedSetting,
  invalidateStripeCache,
  invalidateSSLCommerzCache,
  invalidatePolarCache,
  invalidatePaymentMethodsCache,
} from "./gateway-settings";
export type {
  StripeSettings,
  SSLCommerzSettings,
  PolarSettings,
  PaymentMethodsConfig,
} from "./gateway-settings";

// --- Legacy function exports (backward compatibility) ---
export {
  createPaymentIntent,
  capturePaymentIntent,
  cancelPaymentIntent,
  createRefund,
  retrieveStripeRefund,
  listStripeRefundsForCharge,
  verifyStripeWebhook,
  getStripe,
} from "./stripe";
export { initSSLCommerzSession, validateSSLCommerzIPN, validateSSLCommerzPayment, initiateSSLCommerzRefund, querySSLCommerzRefundStatus } from "./sslcommerz";
export { createPolarCheckout, createPolarRefund, findReusablePolarCheckout, listPolarRefunds, verifyPolarWebhook } from "./polar";
export { initCODTracking, recordCODCollection, recordCODFailure, markCODReturned } from "./cod";

// --- Payment processing ---
export { processPaymentConfirmed, processPaymentFailed, releaseOrderInventory, recordWebhookEvent } from "./process-payment";
export {
  computeOrderPaymentState,
  computePaymentStateAfterPayment,
  computePaymentStateAfterRefund,
  paymentStatesEqual,
} from "./payment-state";
export type {
  ComputedOrderPaymentState,
  ComputePaymentStateInput,
} from "./payment-state";

// --- Refund service ---
export { finalizeAcceptedRefundAttemptIds, processRefund, processReturn } from "./refund-service";
export type {
  FinalizeAcceptedRefundAttemptsResult,
  RefundNotificationFact,
  RefundRequest,
  RefundResult as RefundServiceResult,
} from "./refund-service";
export {
  reconcileDueRefundAttempts,
  reconcileRefundAttemptForOrder,
  reconcileRefundAttemptById,
  reconcileStripeExternalRefundWebhooks,
} from "./refund-reconciliation";
export type {
  ManualRefundAttemptReconciliationReason,
  ManualRefundAttemptReconciliationResult,
  RefundReconciliationOptions,
  RefundReconciliationResult,
  StripeExternalRefundWebhookReconciliationOptions,
  StripeExternalRefundWebhookReconciliationResult,
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
  PaymentSessionGateway,
  PaymentSessionAttemptIdentity,
  ClaimPaymentSessionAttemptInput,
  ClaimedPaymentSessionAttempt,
  PaymentSessionAttemptClaimResult,
} from "./payment-session-attempts";
