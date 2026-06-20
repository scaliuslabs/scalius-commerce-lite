import { eq } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { PaymentPlanStatus, PaymentStatus, paymentPlans, siteSettings } from "@scalius/database/schema";
import { getUnpayableOrderReason } from "@scalius/core/modules/payments/payable-order";
import { pricesEqual, roundPrice, subtractPrice } from "@scalius/shared/price-utils";
import { ValidationError } from "../../utils/api-error";
import type { CheckoutFlowSettings } from "./payment-method-allowlist";

export type PaymentSessionType = "full" | "deposit" | "balance";

export interface PaymentSessionOrder {
  id: string;
  totalAmount: number;
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
      depositAmount: number;
      balanceDue: number;
    }
  | {
      paymentType: "balance";
      chargeAmount: number;
      balanceDue: number;
    }
  | {
      paymentType: "full";
      chargeAmount: number;
    };

function assertPositiveAmount(value: number, label: string): number {
  const amount = roundPrice(Number(value));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ValidationError(`${label} must be greater than zero`);
  }
  return amount;
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
): Promise<PaymentSessionPolicy> {
  const orderTotal = assertPositiveAmount(order.totalAmount, "Order total");
  let cachedPaymentSettings: PartialPaymentSettings | null | undefined = checkoutFlowSettings;
  const getPaymentSettings = async () => {
    if (cachedPaymentSettings !== undefined) return cachedPaymentSettings;
    cachedPaymentSettings = await getPartialPaymentSettings(db);
    return cachedPaymentSettings;
  };

  const inferredPaymentType = await (async (): Promise<PaymentSessionType> => {
    const settings = await getPaymentSettings();
    const configuredDeposit = roundPrice(Number(settings?.partialPaymentAmount ?? 0));
    if (settings?.partialPaymentEnabled && configuredDeposit > 0 && configuredDeposit < orderTotal) {
      return "deposit";
    }
    return "full";
  })();
  const paymentType = requested.paymentType ?? inferredPaymentType;

  if (requested.depositAmount !== undefined && paymentType !== "deposit") {
    throw new ValidationError("depositAmount is only accepted for deposit payments");
  }

  if (paymentType === "deposit") {
    const settings = await getPaymentSettings();
    const configuredDeposit = roundPrice(Number(settings?.partialPaymentAmount ?? 0));
    const paidAmount = roundPrice(Number(order.paidAmount ?? 0));

    if (!settings?.partialPaymentEnabled || configuredDeposit <= 0) {
      throw new ValidationError("Partial payment is not enabled for checkout");
    }
    if (configuredDeposit >= orderTotal) {
      throw new ValidationError("Configured deposit amount must be less than order total");
    }
    if (order.paymentStatus === PaymentStatus.PARTIAL || paidAmount > 0) {
      throw new ValidationError("Order already has a partial payment; use a balance payment");
    }
    if (
      requested.depositAmount !== undefined &&
      !pricesEqual(roundPrice(requested.depositAmount), configuredDeposit)
    ) {
      throw new ValidationError("Deposit amount must match the configured partial payment amount");
    }

    const balanceDue = subtractPrice(orderTotal, configuredDeposit);
    const plan = await getPaymentPlan(db, order.id);
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
      if (
        !pricesEqual(roundPrice(plan.depositAmount), configuredDeposit) ||
        !pricesEqual(roundPrice(plan.balanceDue), balanceDue)
      ) {
        throw new ValidationError("Partial payment plan does not match the current order total");
      }
    }

    return {
      paymentType: "deposit",
      chargeAmount: configuredDeposit,
      depositAmount: configuredDeposit,
      balanceDue,
    };
  }

  if (paymentType === "balance") {
    const plan = await getPaymentPlan(db, order.id);
    const paidAmount = roundPrice(Number(order.paidAmount ?? 0));

    if (!plan || order.paymentStatus !== PaymentStatus.PARTIAL || paidAmount <= 0) {
      throw new ValidationError("No partial payment has been recorded for this order");
    }
    if (plan.status === PaymentPlanStatus.CANCELLED || plan.status === PaymentPlanStatus.COMPLETED) {
      throw new ValidationError("No balance due");
    }
    if (plan.status !== PaymentPlanStatus.DEPOSIT_PAID) {
      throw new ValidationError("Deposit payment must be confirmed before balance payment");
    }

    const storedBalance = plan.balanceDue ?? order.balanceDue;
    const balanceDue = roundPrice(Number(storedBalance ?? subtractPrice(orderTotal, paidAmount)));
    if (!Number.isFinite(balanceDue) || balanceDue <= 0) {
      throw new ValidationError("No balance due");
    }
    const orderBalanceDue = roundPrice(Number(order.balanceDue ?? subtractPrice(orderTotal, paidAmount)));
    if (!pricesEqual(balanceDue, orderBalanceDue)) {
      throw new ValidationError("Payment plan balance does not match the order balance");
    }
    const computedOutstanding = subtractPrice(orderTotal, paidAmount);
    if (!pricesEqual(balanceDue, computedOutstanding)) {
      throw new ValidationError("Payment plan balance does not match the order payment state");
    }

    return {
      paymentType: "balance",
      chargeAmount: balanceDue,
      balanceDue,
    };
  }

  if (paymentType === "full") {
    const settings = await getPaymentSettings();
    const configuredDeposit = roundPrice(Number(settings?.partialPaymentAmount ?? 0));
    if (settings?.partialPaymentEnabled && configuredDeposit > 0 && configuredDeposit < orderTotal) {
      throw new ValidationError("Partial payment is enabled for checkout; use a deposit payment.");
    }
  }

  const paidAmount = roundPrice(Number(order.paidAmount ?? 0));
  const balanceDue = roundPrice(Number(order.balanceDue ?? subtractPrice(orderTotal, paidAmount)));
  if (order.paymentStatus === PaymentStatus.PARTIAL || (paidAmount > 0 && balanceDue > 0)) {
    throw new ValidationError("Order has an outstanding balance; use a balance payment");
  }

  return {
    paymentType: "full",
    chargeAmount: orderTotal,
  };
}
