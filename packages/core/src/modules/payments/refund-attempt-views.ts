// Buyer- and staff-facing views of refund attempts. Types only, so order and
// account views can name them without the refund service.

type RefundAttemptSeverity = "info" | "success" | "warning" | "danger";

export interface OrderRefundAttemptView {
  id: string;
  orderId: string;
  amount: number;
  currency: string;
  gateway: string;
  status: string;
  providerStatus: string | null;
  active: boolean;
  severity: RefundAttemptSeverity;
  label: string;
  message: string;
  createdAt: string | null;
  updatedAt: string | null;
  nextProbeAt: string | null;
  lastProbeAt: string | null;
  refundedAt: string | null;
  failedAt: string | null;
  reason?: string;
  refundPaymentId?: string;
  sourcePaymentId?: string;
  sourceTransactionId?: string | null;
  refundReference?: string;
  providerRefundId?: string | null;
  providerCorrelationId?: string | null;
  allocationIndex?: number;
  allocationCount?: number;
  attempts?: number;
  lastError?: string | null;
}

export interface ActiveRefundOperationView {
  active: true;
  status: string;
  severity: RefundAttemptSeverity;
  label: string;
  message: string;
  amount: number;
  currency: string;
  gateway: string;
  attemptCount: number;
  nextProbeAt: string | null;
  lastProbeAt: string | null;
  providerStatus: string | null;
  reason?: string | null;
  sourceTransactionId?: string | null;
  providerRefundId?: string | null;
  providerCorrelationId?: string | null;
  refundReference?: string | null;
  lastError?: string | null;
}
