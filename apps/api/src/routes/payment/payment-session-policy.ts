import { eq } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { PaymentPlanStatus, PaymentStatus, paymentPlans, siteSettings } from "@scalius/database/schema";
import { getUnpayableOrderReason } from "@scalius/core/modules/payments/payable-order";
import {
  orderMoneyEqual,
  resolveOrderCurrencySnapshot,
  roundOrderMoney,
  type OrderCurrencySnapshot,
} from "@scalius/core/modules/payments/order-currency";
import { normalizeSupportedCurrencyCode } from "@scalius/shared/currency";
import { ValidationError } from "../../utils/api-error";
import type { CheckoutFlowSettings } from "./payment-method-allowlist";

export type PaymentSessionType = "full" | "deposit" | "balance";

export interface PaymentSessionOrder {
  id: string;
  totalAmount: number;
  totalAmountMinor?: number | null;
  currencyCode?: string | null;
  currencyDecimalPlaces?: number | null;
  status: string;
  paymentStatus: string;
  paidAmount?: number | null;
  balanceDue?: number | null;
  deletedAt?: unknown | null;
}

export interface RequestedPaymentSession {
  paymentType?: PaymentSessionType;
  depositAmount?: number;
}

export type PaymentSessionPolicy =
  | {
      paymentType: "deposit";
      chargeAmount: number;
      chargeAmountMinor?: number;
      orderTotal: number;
      depositAmount: number;
      balanceDue: number;
      requiresPlanCreation: boolean;
    }
  | {
      paymentType: "balance";
      chargeAmount: number;
      chargeAmountMinor?: number;
      balanceDue: number;
    }
  | {
      paymentType: "full";
      chargeAmount: number;
      chargeAmountMinor?: number;
    };

function assertPositiveAmount(
  value: number,
  label: string,
  currency: OrderCurrencySnapshot,
): number {
  const amount = roundOrderMoney(Number(value), currency);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ValidationError(`${label} must be greater than zero`);
  }
  return amount;
}

function resolveOrderMoney(
  order: PaymentSessionOrder,
  currencySource?: OrderCurrencySnapshot,
): {
  amount: number;
  amountMinor?: number;
  currency: OrderCurrencySnapshot;
} {
  const currency = currencySource ?? resolveOrderCurrencySnapshot(order);
  const amountMinor = order.totalAmountMinor;
  const hasValidAmountMinor = Number.isSafeInteger(amountMinor) && amountMinor! > 0;

  if (!currency.legacyFallback && !hasValidAmountMinor) {
    throw new ValidationError("Order payment amount snapshot is incomplete. Payment cannot be started safely.");
  }
  if (currency.legacyFallback && amountMinor != null) {
    throw new ValidationError("Order currency snapshot is incomplete. Payment cannot be started safely.");
  }

  if (hasValidAmountMinor) {
    return {
      amount: amountMinor! / 10 ** currency.decimalPlaces,
      amountMinor: amountMinor!,
      currency,
    };
  }
  return {
    amount: assertPositiveAmount(order.totalAmount, "Order total", currency),
    currency,
  };
}

function optionalMinorAmount(amount: number, currency: OrderCurrencySnapshot): number | undefined {
  const normalizedAmount = roundOrderMoney(amount, currency);
  const minor = Math.round(normalizedAmount * 10 ** currency.decimalPlaces);
  return Number.isSafeInteger(minor) && minor > 0 ? minor : undefined;
}

type PartialPaymentSettings = Pick<CheckoutFlowSettings, "partialPaymentEnabled" | "partialPaymentAmount">;

async function getPartialPaymentSettings(db: Database): Promise<PartialPaymentSettings | null | undefined> {
  return db
    .select({
      partialPaymentEnabled: siteSettings.partialPaymentEnabled,
      partialPaymentAmount: siteSettings.partialPaymentAmount,
    })
    .from(siteSettings)
    .get();
}

async function getPaymentPlan(db: Database, orderId: string) {
  return db
    .select({
      totalAmount: paymentPlans.totalAmount,
      depositAmount: paymentPlans.depositAmount,
      balanceDue: paymentPlans.balanceDue,
      status: paymentPlans.status,
    })
    .from(paymentPlans)
    .where(eq(paymentPlans.orderId, orderId))
    .get();
}

export function assertPaymentSessionOrderPayable(order: PaymentSessionOrder): void {
  const unpayableReason = getUnpayableOrderReason(order);
  if (unpayableReason) {
    throw new ValidationError(unpayableReason);
  }
}

export async function resolvePaymentSessionPolicy(
  db: Database,
  order: PaymentSessionOrder,
  requested: RequestedPaymentSession,
  checkoutFlowSettings?: PartialPaymentSettings | null,
  currencySource?: OrderCurrencySnapshot,
  getCurrentCurrencyCode?: () => Promise<string>,
): Promise<PaymentSessionPolicy> {
  const orderMoney = resolveOrderMoney(order, currencySource);
  const currency = orderMoney.currency;
  const orderTotal = assertPositiveAmount(orderMoney.amount, "Order total", currency);
  let cachedPaymentSettings: PartialPaymentSettings | null | undefined = checkoutFlowSettings;
  const getPaymentSettings = async () => {
    if (cachedPaymentSettings !== undefined) return cachedPaymentSettings;
    cachedPaymentSettings = await getPartialPaymentSettings(db);
    return cachedPaymentSettings;
  };
  let paymentPlanPromise: ReturnType<typeof getPaymentPlan> | undefined;
  const getPlan = () => {
    paymentPlanPromise ??= getPaymentPlan(db, order.id);
    return paymentPlanPromise;
  };
  const assertCurrentPartialSettingsUseOrderCurrency = async () => {
    const currentCode = normalizeSupportedCurrencyCode(
      getCurrentCurrencyCode ? await getCurrentCurrencyCode() : null,
    );
    if (!currentCode || currentCode !== currency.code) {
      throw new ValidationError(
        "Partial-payment settings use a different currency than this order. Restore matching currency settings or repair the order with a verified saved payment plan.",
      );
    }
  };

  const getConfiguredDeposit = async (): Promise<{
    enabled: boolean;
    amount: number;
  }> => {
    const settings = await getPaymentSettings();
    if (!settings?.partialPaymentEnabled) return { enabled: false, amount: 0 };

    const rawAmount = Number(settings.partialPaymentAmount ?? 0);
    if (!Number.isFinite(rawAmount)) {
      throw new ValidationError("Configured deposit amount is invalid");
    }
    if (rawAmount > 0) {
      // The setting has no currency column of its own: it belongs to the
      // store's current currency and cannot safely be applied to a historical
      // order from another currency.
      await assertCurrentPartialSettingsUseOrderCurrency();
    }
    return {
      enabled: true,
      amount: roundOrderMoney(rawAmount, currency),
    };
  };

  const plan = await getPlan();
  const paymentType = requested.paymentType ?? await (async (): Promise<PaymentSessionType> => {
    if (plan) {
      if (plan.status === PaymentPlanStatus.PENDING) return "deposit";
      if (plan.status === PaymentPlanStatus.DEPOSIT_PAID) return "balance";
      if (plan.status === PaymentPlanStatus.CANCELLED) {
        throw new ValidationError("Partial payment plan is cancelled");
      }
      throw new ValidationError("Partial payment plan is already completed");
    }

    const configured = await getConfiguredDeposit();
    return configured.enabled && configured.amount > 0 && configured.amount < orderTotal
      ? "deposit"
      : "full";
  })();

  if (requested.depositAmount !== undefined && paymentType !== "deposit") {
    throw new ValidationError("depositAmount is only accepted for deposit payments");
  }

  if (paymentType === "deposit") {
    const paidAmount = roundOrderMoney(Number(order.paidAmount ?? 0), currency);
    if (order.paymentStatus === PaymentStatus.PARTIAL || paidAmount > 0) {
      throw new ValidationError("Order already has a partial payment; use a balance payment");
    }

    let depositAmount: number;
    let balanceDue: number;
    if (plan) {
      if (plan.status === PaymentPlanStatus.CANCELLED) {
        throw new ValidationError("Partial payment plan is cancelled");
      }
      if (plan.status === PaymentPlanStatus.DEPOSIT_PAID || plan.status === PaymentPlanStatus.COMPLETED) {
        throw new ValidationError("Deposit payment has already been confirmed");
      }
      if (plan.status !== PaymentPlanStatus.PENDING) {
        throw new ValidationError("Deposit payment plan is not ready");
      }
      const planTotal = assertPositiveAmount(plan.totalAmount, "Payment plan total", currency);
      depositAmount = assertPositiveAmount(plan.depositAmount, "Payment plan deposit", currency);
      balanceDue = assertPositiveAmount(plan.balanceDue, "Payment plan balance", currency);
      if (
        !orderMoneyEqual(planTotal, orderTotal, currency) ||
        !orderMoneyEqual(
          roundOrderMoney(depositAmount + balanceDue, currency),
          orderTotal,
          currency,
        )
      ) {
        throw new ValidationError("Partial payment plan does not match the immutable order total");
      }
    } else {
      const configured = await getConfiguredDeposit();
      depositAmount = configured.amount;
      if (!configured.enabled || depositAmount <= 0) {
        throw new ValidationError("Partial payment is not enabled for checkout");
      }
      if (depositAmount >= orderTotal) {
        throw new ValidationError("Configured deposit amount must be less than order total");
      }
      balanceDue = roundOrderMoney(orderTotal - depositAmount, currency);
    }

    if (
      requested.depositAmount !== undefined &&
      !orderMoneyEqual(requested.depositAmount, depositAmount, currency)
    ) {
      throw new ValidationError(
        plan
          ? "Deposit amount must match the saved partial payment plan"
          : "Deposit amount must match the configured partial payment amount",
      );
    }

    return {
      paymentType: "deposit",
      chargeAmount: depositAmount,
      chargeAmountMinor: optionalMinorAmount(depositAmount, currency),
      orderTotal,
      depositAmount,
      balanceDue,
      requiresPlanCreation: !plan,
    };
  }

  if (paymentType === "balance") {
    const paidAmount = roundOrderMoney(Number(order.paidAmount ?? 0), currency);

    if (!plan || order.paymentStatus !== PaymentStatus.PARTIAL || paidAmount <= 0) {
      throw new ValidationError("No partial payment has been recorded for this order");
    }
    if (plan.status === PaymentPlanStatus.CANCELLED || plan.status === PaymentPlanStatus.COMPLETED) {
      throw new ValidationError("No balance due");
    }
    if (plan.status !== PaymentPlanStatus.DEPOSIT_PAID) {
      throw new ValidationError("Deposit payment must be confirmed before balance payment");
    }

    const planTotal = assertPositiveAmount(plan.totalAmount, "Payment plan total", currency);
    const planDeposit = assertPositiveAmount(plan.depositAmount, "Payment plan deposit", currency);
    const balanceDue = assertPositiveAmount(plan.balanceDue, "Payment plan balance", currency);
    if (
      !orderMoneyEqual(planTotal, orderTotal, currency) ||
      !orderMoneyEqual(
        roundOrderMoney(planDeposit + balanceDue, currency),
        orderTotal,
        currency,
      )
    ) {
      throw new ValidationError("Partial payment plan does not match the immutable order total");
    }
    if (!orderMoneyEqual(planDeposit, paidAmount, currency)) {
      throw new ValidationError("Payment plan deposit does not match the order payment state");
    }
    const orderBalanceDue = roundOrderMoney(
      Number(order.balanceDue ?? (orderTotal - paidAmount)),
      currency,
    );
    if (!orderMoneyEqual(balanceDue, orderBalanceDue, currency)) {
      throw new ValidationError("Payment plan balance does not match the order balance");
    }
    const computedOutstanding = roundOrderMoney(orderTotal - paidAmount, currency);
    if (!orderMoneyEqual(balanceDue, computedOutstanding, currency)) {
      throw new ValidationError("Payment plan balance does not match the order payment state");
    }

    return {
      paymentType: "balance",
      chargeAmount: balanceDue,
      chargeAmountMinor: optionalMinorAmount(balanceDue, currency),
      balanceDue,
    };
  }

  if (paymentType === "full") {
    if (plan) {
      if (plan.status === PaymentPlanStatus.PENDING) {
        throw new ValidationError("Order has an active partial payment plan; use a deposit payment.");
      }
      if (plan.status === PaymentPlanStatus.DEPOSIT_PAID) {
        throw new ValidationError("Order has an outstanding balance; use a balance payment");
      }
      if (plan.status === PaymentPlanStatus.CANCELLED) {
        throw new ValidationError("Partial payment plan is cancelled");
      }
      throw new ValidationError("Partial payment plan is already completed");
    }

    const configured = await getConfiguredDeposit();
    if (configured.enabled && configured.amount > 0 && configured.amount < orderTotal) {
      throw new ValidationError("Partial payment is enabled for checkout; use a deposit payment.");
    }
  }

  const paidAmount = roundOrderMoney(Number(order.paidAmount ?? 0), currency);
  const balanceDue = roundOrderMoney(
    Number(order.balanceDue ?? (orderTotal - paidAmount)),
    currency,
  );
  if (order.paymentStatus === PaymentStatus.PARTIAL || (paidAmount > 0 && balanceDue > 0)) {
    throw new ValidationError("Order has an outstanding balance; use a balance payment");
  }

  return {
    paymentType: "full",
    chargeAmount: orderTotal,
    chargeAmountMinor: orderMoney.amountMinor,
  };
}
