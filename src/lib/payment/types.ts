// src/lib/payment/types.ts
// Shared types for payment gateway integrations.

export type PaymentGateway = "stripe" | "sslcommerz" | "cod";
export type PaymentType = "full" | "deposit" | "balance";
export type PaymentResult = "succeeded" | "failed" | "pending" | "cancelled";

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

export interface CreateStripePaymentIntentParams {
  orderId: string;
  amount: number; // In smallest currency unit (e.g. cents, paisa)
  currency: string; // ISO 4217 lowercase (usd, bdt)
  paymentType: PaymentType;
  /** Set to true for manual capture (authorise now, capture on fulfilment) */
  manualCapture?: boolean;
  metadata?: Record<string, string>;
}

export interface StripePaymentIntentResult {
  success: boolean;
  clientSecret?: string;
  paymentIntentId?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// SSLCommerz
// ---------------------------------------------------------------------------

export interface InitSSLCommerzSessionParams {
  orderId: string;
  totalAmount: number; // BDT (or other currency)
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
  paymentType: PaymentType;
  productName?: string;
  numItems?: number;
}

export interface SSLCommerzSessionResult {
  success: boolean;
  gatewayUrl?: string; // Redirect customer to this URL
  sessionKey?: string; // SSLCommerz session key (stored as paymentIntentId)
  error?: string;
}

export interface SSLCommerzIPNPayload {
  status: string; // VALID | VALIDATED | INVALID_TRANSACTION | FAILED | etc.
  tran_id: string; // Our order ID / transaction ID
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
  amount: number;
  paymentGateway: PaymentGateway;
  paymentType: PaymentType;
  stripePaymentIntentId?: string;
  stripeChargeId?: string;
  sslcommerzTranId?: string;
  sslcommerzValId?: string;
  sslcommerzBankTranId?: string;
  metadata?: Record<string, unknown>;
}
