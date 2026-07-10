import { PaymentStatus, type PaymentStatusType } from "@scalius/database/schema";
import {
  orderMoneyEqual,
  resolveOrderCurrencySnapshot,
  roundOrderMoney,
  type OrderCurrencySnapshotSource,
} from "./order-currency";

export interface ComputedOrderPaymentState {
  paidAmount: number;
  balanceDue: number;
  paymentStatus: PaymentStatusType;
}

export interface ComputePaymentStateInput {
  totalAmount: number;
  paidAmount: number | null | undefined;
  paymentStatus?: PaymentStatusType;
  currency?: OrderCurrencySnapshotSource;
}

export function computeOrderPaymentState(input: ComputePaymentStateInput): ComputedOrderPaymentState {
  const currency = resolveOrderCurrencySnapshot(input.currency ?? {});
  const totalAmount = roundOrderMoney(Math.max(0, Number(input.totalAmount ?? 0)), currency);
  const paidAmount = roundOrderMoney(Math.max(0, Number(input.paidAmount ?? 0)), currency);
  const balanceDue = roundOrderMoney(Math.max(0, totalAmount - paidAmount), currency);

  if (input.paymentStatus) {
    return { paidAmount, balanceDue, paymentStatus: input.paymentStatus };
  }

  if (paidAmount <= 0) {
    return { paidAmount, balanceDue, paymentStatus: PaymentStatus.UNPAID };
  }

  if (orderMoneyEqual(balanceDue, 0, currency) || paidAmount >= totalAmount) {
    return { paidAmount, balanceDue: 0, paymentStatus: PaymentStatus.PAID };
  }

  return { paidAmount, balanceDue, paymentStatus: PaymentStatus.PARTIAL };
}

export function computePaymentStateAfterPayment(input: {
  totalAmount: number;
  currentPaidAmount: number | null | undefined;
  paymentAmount: number;
  currency?: OrderCurrencySnapshotSource;
}): ComputedOrderPaymentState {
  const currency = resolveOrderCurrencySnapshot(input.currency ?? {});
  return computeOrderPaymentState({
    totalAmount: input.totalAmount,
    paidAmount: roundOrderMoney(Number(input.currentPaidAmount ?? 0) + input.paymentAmount, currency),
    currency,
  });
}

export function computePaymentStateAfterRefund(input: {
  totalAmount: number;
  currentPaidAmount: number | null | undefined;
  refundAmount: number;
  isFullRefund: boolean;
  currency?: OrderCurrencySnapshotSource;
}): ComputedOrderPaymentState {
  const currency = resolveOrderCurrencySnapshot(input.currency ?? {});
  const paidAmount = roundOrderMoney(
    Math.max(0, Number(input.currentPaidAmount ?? 0) - input.refundAmount),
    currency,
  );

  return computeOrderPaymentState({
    totalAmount: input.totalAmount,
    paidAmount,
    paymentStatus: input.isFullRefund || paidAmount <= 0
      ? PaymentStatus.REFUNDED
      : PaymentStatus.PARTIAL,
    currency,
  });
}

export function paymentStatesEqual(
  actual: {
    paidAmount: number | null | undefined;
    balanceDue: number | null | undefined;
    paymentStatus: string | null | undefined;
  },
  expected: ComputedOrderPaymentState,
  currencySource: OrderCurrencySnapshotSource = {},
): boolean {
  const currency = resolveOrderCurrencySnapshot(currencySource);
  return (
    orderMoneyEqual(Number(actual.paidAmount ?? 0), expected.paidAmount, currency) &&
    orderMoneyEqual(Number(actual.balanceDue ?? 0), expected.balanceDue, currency) &&
    actual.paymentStatus === expected.paymentStatus
  );
}
