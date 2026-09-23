// Shared payment types. Order amounts in the database are MAJOR units; provider
// adapters (gateways/port.ts) exchange integer minor units at their boundary.

export type { PaymentType } from "./gateways/port";
import type { PaymentType } from "./gateways/port";

export type PaymentResult = "succeeded" | "failed" | "pending" | "cancelled";

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
  /** Gateway id (registry key); stored as order_payments.payment_method. */
  provider: string;
  /** Major units in the order currency. */
  amount: number;
  currency: string;
  /** Omitted when the provider did not bind one; the kernel infers it from the amount. */
  paymentType?: PaymentType;
  providerRef: string;
  secondaryRef?: string;
  metadata?: Record<string, unknown>;
}
