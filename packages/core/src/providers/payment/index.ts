// packages/core/src/providers/payment/index.ts
// Barrel exports for payment providers.

export type {
  PaymentProvider,
  CreatePaymentParams,
  CreatePaymentResult,
  RefundParams,
  RefundResult,
  WebhookPayload,
  PaymentType,
} from "./types";

// Import adapter to ensure it registers with the universal registry
import "./stripe-adapter";
