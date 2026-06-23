import { PaymentStatus, type PaymentStatusType } from "@scalius/database/schema";
import { pricesEqual, roundPrice } from "@scalius/shared/price-utils";

export interface ComputedOrderPaymentState {
  paidAmount: number;
  balanceDue: number;
  paymentStatus: PaymentStatusType;
}

export interface ComputePaymentStateInput {
  totalAmount: number;
  paidAmount: number | null | undefined;
  paymentStatus?: PaymentStatusType;
}

export function computeOrderPaymentState(input: ComputePaymentStateInput): ComputedOrderPaymentState {
  const totalAmount = roundPrice(Math.max(0, Number(input.totalAmount ?? 0)));
  const paidAmount = roundPrice(Math.max(0, Number(input.paidAmount ?? 0)));
  const balanceDue = roundPrice(Math.max(0, totalAmount - paidAmount));

  if (input.paymentStatus) {
    return { paidAmount, balanceDue, paymentStatus: input.paymentStatus };
  }

  if (paidAmount <= 0) {
    return { paidAmount, balanceDue, paymentStatus: PaymentStatus.UNPAID };
  }

  if (pricesEqual(balanceDue, 0) || paidAmount >= totalAmount) {
    return { paidAmount, balanceDue: 0, paymentStatus: PaymentStatus.PAID };
  }

  return { paidAmount, balanceDue, paymentStatus: PaymentStatus.PARTIAL };
}

export function computePaymentStateAfterPayment(input: {
  totalAmount: number;
  currentPaidAmount: number | null | undefined;
  paymentAmount: number;
}): ComputedOrderPaymentState {
  return computeOrderPaymentState({
    totalAmount: input.totalAmount,
    paidAmount: roundPrice(Number(input.currentPaidAmount ?? 0) + input.paymentAmount),
  });
}

export function computePaymentStateAfterRefund(input: {
  totalAmount: number;
  currentPaidAmount: number | null | undefined;
  refundAmount: number;
  isFullRefund: boolean;
}): ComputedOrderPaymentState {
  const paidAmount = roundPrice(Math.max(0, Number(input.currentPaidAmount ?? 0) - input.refundAmount));

  return computeOrderPaymentState({
    totalAmount: input.totalAmount,
    paidAmount,
    paymentStatus: input.isFullRefund || paidAmount <= 0
      ? PaymentStatus.REFUNDED
      : PaymentStatus.PARTIAL,
  });
}

export function paymentStatesEqual(
  actual: {
    paidAmount: number | null | undefined;
    balanceDue: number | null | undefined;
    paymentStatus: string | null | undefined;
  },
  expected: ComputedOrderPaymentState,
): boolean {
  return (
    pricesEqual(roundPrice(Number(actual.paidAmount ?? 0)), expected.paidAmount) &&
    pricesEqual(roundPrice(Number(actual.balanceDue ?? 0)), expected.balanceDue) &&
    actual.paymentStatus === expected.paymentStatus
  );
}
