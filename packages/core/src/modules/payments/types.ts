// Shared payment types. Every stored and computed amount is integer minor units.

export type { PaymentType } from "./gateways/port";
import type { PaymentType } from "./gateways/port";
import type { ReportedSettlement } from "@scalius/shared/money-chain";
import type { SavedPaymentMethod } from "@scalius/shared/plugins/providers/payment";

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
  /** Integer minor units of the order currency. */
  collectedAmountMinor: number;
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
  /** Integer minor units in the order currency. */
  amountMinor: number;
  currency: string;
  /** Omitted when the provider did not bind one; the kernel infers it from the amount. */
  paymentType?: PaymentType;
  providerRef: string;
  secondaryRef?: string;
  metadata?: Record<string, unknown>;
  /** What the provider reported reached the merchant (the payment port's `settlement`); absent: settled as presented. */
  settlement?: ReportedSettlement | null;
  /**
   * The payment method the provider kept with this payment (a session that
   * asked to keep it). Saved for the order's account customer in the batch
   * that applies the payment; ignored for a guest order.
   */
  savedPaymentMethod?: SavedPaymentMethod | null;
}
