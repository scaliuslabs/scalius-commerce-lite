import { eq } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { PaymentPlanStatus, PaymentStatus, paymentPlans } from "@scalius/database/schema";
import { checkoutDocument } from "@scalius/core/modules/settings/documents";
import { getUnpayableOrderReason, type PayableOrderState } from "@scalius/core/modules/payments/payable-order";
import {
  resolveOrderCurrencySnapshot,
  type OrderCurrencySnapshot,
} from "@scalius/core/modules/payments/order-currency";
import { normalizeSupportedCurrencyCode } from "@scalius/shared/currency";
import { fromMinor, toMinor } from "@scalius/shared/money";
import { ValidationError } from "../../utils/api-error";
import type { CheckoutFlowSettings } from "./payment-method-allowlist";

export type PaymentSessionType = "full" | "deposit" | "balance";

/** Order money is integer minor units of the order's own currency. */
export interface PaymentSessionOrder {
  id: string;
  totalAmountMinor: number;
  currencyCode: string;
  currencyDecimalPlaces: number;
  status: string;
  paymentStatus: string;
  paidAmountMinor: number;
  balanceDueMinor: number;
  deletedAt?: unknown | null;
}

export interface RequestedPaymentSession {
  paymentType?: PaymentSessionType;
  /** Decimal major units, as sent over HTTP. */
  depositAmount?: number;
}

/** Amounts are minor units; `chargeAmount`/`depositAmount` are the decimal HTTP views. */
export type PaymentSessionPolicy =
  | {
      paymentType: "deposit";
      chargeAmount: number;
      chargeAmountMinor: number;
      orderTotalMinor: number;
      depositAmount: number;
      depositAmountMinor: number;
      balanceDueMinor: number;
      requiresPlanCreation: boolean;
    }
  | {
      paymentType: "balance";
      chargeAmount: number;
      chargeAmountMinor: number;
    }
  | {
      paymentType: "full";
      chargeAmount: number;
      chargeAmountMinor: number;
    };

function assertPositiveMinor(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new ValidationError(`${label} must be greater than zero`);
  }
  return Number(value);
}

function decimalToOrderMinor(amount: number, currency: OrderCurrencySnapshot, label: string): number {
  try {
    return toMinor(amount, currency.decimalPlaces);
  } catch {
    throw new ValidationError(`${label} is invalid`);
  }
}

type PartialPaymentSettings = Pick<CheckoutFlowSettings, "partialPaymentEnabled" | "partialPaymentAmount">;

async function getPaymentPlan(db: Database, orderId: string) {
  return db
    .select({
      totalAmountMinor: paymentPlans.totalAmountMinor,
      depositAmountMinor: paymentPlans.depositAmountMinor,
      balanceDueMinor: paymentPlans.balanceDueMinor,
      status: paymentPlans.status,
    })
    .from(paymentPlans)
    .where(eq(paymentPlans.orderId, orderId))
    .get();
}

export function assertPaymentSessionOrderPayable(order: PayableOrderState): void {
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
  const currency = currencySource ?? resolveOrderCurrencySnapshot(order);
  const orderTotalMinor = assertPositiveMinor(order.totalAmountMinor, "Order total");
  const paidAmountMinor = Number(order.paidAmountMinor ?? 0);
  const present = (minor: number) => fromMinor(minor, currency.decimalPlaces);
  let cachedPaymentSettings: PartialPaymentSettings | null | undefined = checkoutFlowSettings;
  const getPaymentSettings = async () => {
    if (cachedPaymentSettings !== undefined) return cachedPaymentSettings;
    cachedPaymentSettings = await checkoutDocument.read(db);
    return cachedPaymentSettings;
  };

  const getConfiguredDepositMinor = async (): Promise<{ enabled: boolean; amountMinor: number }> => {
    const settings = await getPaymentSettings();
    if (!settings?.partialPaymentEnabled) return { enabled: false, amountMinor: 0 };

    const rawAmount = Number(settings.partialPaymentAmount ?? 0);
    if (!Number.isFinite(rawAmount) || rawAmount < 0) {
      throw new ValidationError("Configured deposit amount is invalid");
    }
    if (rawAmount > 0) {
      // The setting has no currency of its own: it belongs to the store's
      // current currency and cannot be applied to an order in another one.
      const currentCode = normalizeSupportedCurrencyCode(
        getCurrentCurrencyCode ? await getCurrentCurrencyCode() : null,
      );
      if (!currentCode || currentCode !== currency.code) {
        throw new ValidationError(
          "Partial-payment settings use a different currency than this order. Restore matching currency settings or repair the order with a verified saved payment plan.",
        );
      }
    }
    return { enabled: true, amountMinor: decimalToOrderMinor(rawAmount, currency, "Configured deposit amount") };
  };

  const plan = await getPaymentPlan(db, order.id);
  const assertPlanMatchesOrder = (saved: NonNullable<typeof plan>) => {
    const planTotal = assertPositiveMinor(saved.totalAmountMinor, "Payment plan total");
    const planDeposit = assertPositiveMinor(saved.depositAmountMinor, "Payment plan deposit");
    const planBalance = assertPositiveMinor(saved.balanceDueMinor, "Payment plan balance");
    if (planTotal !== orderTotalMinor || planDeposit + planBalance !== orderTotalMinor) {
      throw new ValidationError("Partial payment plan does not match the immutable order total");
    }
    return { planDeposit, planBalance };
  };

  const paymentType = requested.paymentType ?? await (async (): Promise<PaymentSessionType> => {
    if (plan) {
      if (plan.status === PaymentPlanStatus.PENDING) return "deposit";
      if (plan.status === PaymentPlanStatus.DEPOSIT_PAID) return "balance";
      if (plan.status === PaymentPlanStatus.CANCELLED) {
        throw new ValidationError("Partial payment plan is cancelled");
      }
      throw new ValidationError("Partial payment plan is already completed");
    }

    const configured = await getConfiguredDepositMinor();
    return configured.enabled && configured.amountMinor > 0 && configured.amountMinor < orderTotalMinor
      ? "deposit"
      : "full";
  })();

  if (requested.depositAmount !== undefined && paymentType !== "deposit") {
    throw new ValidationError("depositAmount is only accepted for deposit payments");
  }

  if (paymentType === "deposit") {
    if (order.paymentStatus === PaymentStatus.PARTIAL || paidAmountMinor > 0) {
      throw new ValidationError("Order already has a partial payment; use a balance payment");
    }

    let depositAmountMinor: number;
    let balanceDueMinor: number;
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
      const saved = assertPlanMatchesOrder(plan);
      depositAmountMinor = saved.planDeposit;
      balanceDueMinor = saved.planBalance;
    } else {
      const configured = await getConfiguredDepositMinor();
      depositAmountMinor = configured.amountMinor;
      if (!configured.enabled || depositAmountMinor <= 0) {
        throw new ValidationError("Partial payment is not enabled for checkout");
      }
      if (depositAmountMinor >= orderTotalMinor) {
        throw new ValidationError("Configured deposit amount must be less than order total");
      }
      balanceDueMinor = orderTotalMinor - depositAmountMinor;
    }

    if (
      requested.depositAmount !== undefined &&
      decimalToOrderMinor(requested.depositAmount, currency, "Deposit amount") !== depositAmountMinor
    ) {
      throw new ValidationError(
        plan
          ? "Deposit amount must match the saved partial payment plan"
          : "Deposit amount must match the configured partial payment amount",
      );
    }

    return {
      paymentType: "deposit",
      chargeAmount: present(depositAmountMinor),
      chargeAmountMinor: depositAmountMinor,
      orderTotalMinor,
      depositAmount: present(depositAmountMinor),
      depositAmountMinor,
      balanceDueMinor,
      requiresPlanCreation: !plan,
    };
  }

  if (paymentType === "balance") {
    if (!plan || order.paymentStatus !== PaymentStatus.PARTIAL || paidAmountMinor <= 0) {
      throw new ValidationError("No partial payment has been recorded for this order");
    }
    if (plan.status === PaymentPlanStatus.CANCELLED || plan.status === PaymentPlanStatus.COMPLETED) {
      throw new ValidationError("No balance due");
    }
    if (plan.status !== PaymentPlanStatus.DEPOSIT_PAID) {
      throw new ValidationError("Deposit payment must be confirmed before balance payment");
    }

    const { planDeposit, planBalance } = assertPlanMatchesOrder(plan);
    if (planDeposit !== paidAmountMinor) {
      throw new ValidationError("Payment plan deposit does not match the order payment state");
    }
    if (planBalance !== Number(order.balanceDueMinor)) {
      throw new ValidationError("Payment plan balance does not match the order balance");
    }
    if (planBalance !== orderTotalMinor - paidAmountMinor) {
      throw new ValidationError("Payment plan balance does not match the order payment state");
    }

    return {
      paymentType: "balance",
      chargeAmount: present(planBalance),
      chargeAmountMinor: planBalance,
    };
  }

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

  const configured = await getConfiguredDepositMinor();
  if (configured.enabled && configured.amountMinor > 0 && configured.amountMinor < orderTotalMinor) {
    throw new ValidationError("Partial payment is enabled for checkout; use a deposit payment.");
  }

  if (order.paymentStatus === PaymentStatus.PARTIAL || (paidAmountMinor > 0 && Number(order.balanceDueMinor) > 0)) {
    throw new ValidationError("Order has an outstanding balance; use a balance payment");
  }

  return {
    paymentType: "full",
    chargeAmount: present(orderTotalMinor),
    chargeAmountMinor: orderTotalMinor,
  };
}
