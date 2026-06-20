// src/lib/payment/types.ts
// Shared types for payment gateway integrations.
//
// ── Amount convention ────────────────────────────────────────────────────────
// Amounts stored in the database (orders.totalAmount, etc.) are in MAJOR units
// (e.g. 150.00 BDT, 29.99 USD). This is the canonical representation.
//
// Gateway APIs each have their own convention:
//   Stripe & Polar — expect amounts in SMALLEST currency unit (cents, paisa, fils).
//     Conversion: amount * 10^(ISO 4217 decimal places).
//     e.g. 150.00 BDT → 15000, 150 JPY → 150, 1.500 BHD → 1500.
//     This conversion happens at the API route layer before calling gateway functions.
//     The queue consumer reverses it (÷ 10^decimals) before writing to the DB.
//   SSLCommerz — expects amounts in MAJOR units with appropriate decimal formatting.
//     Uses toFixed(getDecimalPlaces(currency)) for the API call.
//     No ×/÷ conversion needed; the amount passes through as-is.
//   COD — no external gateway; amounts are always in major units.
//
// Use getDecimalPlaces() from @scalius/shared/currency for the ISO 4217 lookup.
// ─────────────────────────────────────────────────────────────────────────────

export type PaymentGateway = "stripe" | "sslcommerz" | "polar" | "cod";
export type PaymentType = "full" | "deposit" | "balance";
export type PaymentResult = "succeeded" | "failed" | "pending" | "cancelled";

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

export interface CreateStripePaymentIntentParams {
  orderId: string;
  amount: number; // In smallest currency unit — use getDecimalPlaces(currency) for conversion
  currency: string; // ISO 4217 lowercase (usd, bdt, jpy)
  paymentType: PaymentType;
  /** Set to true for manual capture (authorise now, capture on fulfilment) */
  manualCapture?: boolean;
  /** Provider-side idempotency key for checkout/session retries */
  idempotencyKey?: string;
  /** Per-provider HTTP deadline in milliseconds for checkout/session creation. */
  requestTimeoutMs?: number;
  /** Disable SDK network retries for buyer-facing session creation hot paths. */
  maxNetworkRetries?: number;
  metadata?: Record<string, string>;
}

export interface StripePaymentIntentResult {
  success: boolean;
  clientSecret?: string;
  paymentIntentId?: string;
  error?: string;
  timedOut?: boolean;
}

// ---------------------------------------------------------------------------
// SSLCommerz
// ---------------------------------------------------------------------------

export interface InitSSLCommerzSessionParams {
  orderId: string;
  transactionId?: string;
  totalAmount: number; // Major units (e.g. 150.00 BDT) — SSLCommerz formats via toFixed(decimals)
  currency: string; // BDT | USD | EUR | GBP | SGD
  successUrl: string;
  failUrl: string;
  cancelUrl: string;
  ipnUrl: string;
  customerName: string;
  customerPhone: string;
  customerEmail?: string;
  customerAddress?: string;
  customerCity?: string;
  customerPostcode?: string;
  paymentType: PaymentType;
  productName?: string;
  numItems?: number;
  /** Abort signal from the API route deadline guard. */
  signal?: AbortSignal;
}

export interface SSLCommerzSessionResult {
  success: boolean;
  gatewayUrl?: string; // Redirect customer to this URL
  sessionKey?: string; // SSLCommerz session key (stored as paymentIntentId)
  error?: string;
  timedOut?: boolean;
}

export interface SSLCommerzIPNPayload {
  status: string; // VALID | VALIDATED | INVALID_TRANSACTION | FAILED | etc.
  tran_id: string; // Merchant transaction/attempt ID
  val_id: string; // SSLCommerz validation ID
  amount: string;
  store_amount: string;
  currency: string;
  bank_tran_id: string;
  card_type: string;
  card_no: string;
  card_issuer: string;
  card_brand: string;
  card_issuer_country: string;
  card_issuer_country_code: string;
  currency_type: string;
  currency_amount: string;
  currency_rate: string;
  base_fair: string;
  value_a?: string;
  value_b?: string;
  value_c?: string;
  value_d?: string;
  [key: string]: string | undefined;
}

export interface SSLCommerzValidationResult {
  status: "VALID" | "VALIDATED" | "INVALID_TRANSACTION" | "FAILED" | "UNATTEMPTED" | "CANCELLED" | "PENDING" | "EXPIRED";
  tran_id: string;
  val_id: string;
  amount: string;
  store_amount: string;
  bank_tran_id: string;
  card_type: string;
  currency_type: string;
  currency_amount: string;
  [key: string]: string;
}

// ---------------------------------------------------------------------------
// Polar
// ---------------------------------------------------------------------------

export interface CreatePolarCheckoutParams {
  orderId: string;
  amount: number; // In smallest currency unit — use getDecimalPlaces(currency) for conversion
  currency: string; // ISO 4217 lowercase (usd, jpy, bdt)
  productId: string; // Polar product ID (required by Polar)
  paymentType: PaymentType;
  successUrl: string;
  cancelUrl?: string;
  customerName?: string;
  customerEmail?: string;
  metadata?: Record<string, string>;
  /** Per-provider HTTP deadline in milliseconds for checkout/session creation. */
  requestTimeoutMs?: number;
  /** Abort signal from the API route deadline guard. */
  signal?: AbortSignal;
}

export interface PolarCheckoutResult {
  success: boolean;
  checkoutUrl?: string; // Redirect customer to this URL
  checkoutId?: string; // Polar checkout session ID
  error?: string;
  timedOut?: boolean;
}

export interface PolarRefundParams {
  polarOrderId: string; // The ID of the order within Polar, which usually matches checkoutId
  amount: number; // In smallest currency unit. Must be explicitly provided.
  reason?: "fraudulent" | "customer_request" | "duplicate" | "other" | "service_disruption" | "satisfaction_guarantee" | "dispute_prevention";
  comment?: string;
}

export interface PolarRefundResult {
  success: boolean;
  refundId?: string; // Polar refund ID
  error?: string;
}

// ---------------------------------------------------------------------------
// COD
// ---------------------------------------------------------------------------

export interface InitCODTrackingParams {
  orderId: string;
}

export interface RecordCODCollectionParams {
  orderId: string;
  collectedBy: string; // Courier name or employee ID
  collectedAmount: number;
  receiptUrl?: string;
}

export interface RecordCODFailureParams {
  orderId: string;
  reason: "not_home" | "refused" | "no_cash" | "wrong_address" | "other";
  notes?: string;
}

// ---------------------------------------------------------------------------
// Payment processing (shared)
// ---------------------------------------------------------------------------

export interface ProcessPaymentParams {
  orderId: string;
  amount: number; // Major units (e.g. 150.00 BDT) — queue consumer converts from smallest unit before calling
  paymentGateway: PaymentGateway;
  paymentType: PaymentType;
  stripePaymentIntentId?: string;
  stripeChargeId?: string;
  sslcommerzTranId?: string;
  sslcommerzValId?: string;
  sslcommerzBankTranId?: string;
  polarCheckoutId?: string;
  metadata?: Record<string, unknown>;
}
