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
export { createPaymentIntent, capturePaymentIntent, cancelPaymentIntent, createRefund, verifyStripeWebhook, getStripe } from "./stripe";
export { initSSLCommerzSession, validateSSLCommerzIPN, validateSSLCommerzPayment, initiateSSLCommerzRefund, querySSLCommerzRefundStatus } from "./sslcommerz";
export { createPolarCheckout, createPolarRefund, verifyPolarWebhook } from "./polar";
export { initCODTracking, recordCODCollection, recordCODFailure, markCODReturned } from "./cod";

// --- Payment processing ---
export { processPaymentConfirmed, processPaymentFailed, releaseOrderInventory, recordWebhookEvent } from "./process-payment";

// --- Refund service ---
export { processRefund, processReturn } from "./refund-service";
export type { RefundRequest, RefundResult as RefundServiceResult } from "./refund-service";

// --- Public payment session attempts ---
export {
  buildPaymentSessionAttemptIdentity,
  claimPaymentSessionAttempt,
  markPaymentSessionAttemptCreated,
  markPaymentSessionAttemptFailed,
} from "./payment-session-attempts";
export type {
  PaymentSessionGateway,
  PaymentSessionAttemptIdentity,
  ClaimPaymentSessionAttemptInput,
  ClaimedPaymentSessionAttempt,
  PaymentSessionAttemptClaimResult,
} from "./payment-session-attempts";
