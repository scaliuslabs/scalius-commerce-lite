import { PaymentStatus, type PaymentStatusType } from "@scalius/database/schema";

/** Order payment state; every amount is integer minor units of the order currency. */
export interface ComputedOrderPaymentState {
  paidAmountMinor: number;
  balanceDueMinor: number;
  paymentStatus: PaymentStatusType;
}

export interface ComputePaymentStateInput {
  totalAmountMinor: number;
  paidAmountMinor: number;
  paymentStatus?: PaymentStatusType;
}

export function computeOrderPaymentState(input: ComputePaymentStateInput): ComputedOrderPaymentState {
  const totalAmountMinor = Math.max(0, input.totalAmountMinor);
  const paidAmountMinor = Math.max(0, input.paidAmountMinor);
  const balanceDueMinor = Math.max(0, totalAmountMinor - paidAmountMinor);

  if (input.paymentStatus) {
    return { paidAmountMinor, balanceDueMinor, paymentStatus: input.paymentStatus };
  }
  if (paidAmountMinor <= 0) {
    return { paidAmountMinor, balanceDueMinor, paymentStatus: PaymentStatus.UNPAID };
  }
  if (balanceDueMinor === 0) {
    return { paidAmountMinor, balanceDueMinor, paymentStatus: PaymentStatus.PAID };
  }
  return { paidAmountMinor, balanceDueMinor, paymentStatus: PaymentStatus.PARTIAL };
}

export function computePaymentStateAfterPayment(input: {
  totalAmountMinor: number;
  currentPaidAmountMinor: number;
  paymentAmountMinor: number;
}): ComputedOrderPaymentState {
  return computeOrderPaymentState({
    totalAmountMinor: input.totalAmountMinor,
    paidAmountMinor: input.currentPaidAmountMinor + input.paymentAmountMinor,
  });
}
