import { eq } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { PaymentStatus, paymentPlans, siteSettings } from "@scalius/database/schema";
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
  const paymentType = requested.paymentType ?? "full";
  const orderTotal = assertPositiveAmount(order.totalAmount, "Order total");
  const getPaymentSettings = () => checkoutFlowSettings
    ? Promise.resolve(checkoutFlowSettings)
    : getPartialPaymentSettings(db);

  if (requested.depositAmount !== undefined && paymentType !== "deposit") {
    throw new ValidationError("depositAmount is only accepted for deposit payments");
  }

  if (paymentType === "deposit") {
    const settings = await getPaymentSettings();
    const configuredDeposit = roundPrice(Number(settings?.partialPaymentAmount ?? 0));

    if (!settings?.partialPaymentEnabled || configuredDeposit <= 0) {
      throw new ValidationError("Partial payment is not enabled for checkout");
    }
    if (configuredDeposit >= orderTotal) {
      throw new ValidationError("Configured deposit amount must be less than order total");
    }
    if (
      requested.depositAmount !== undefined &&
      !pricesEqual(roundPrice(requested.depositAmount), configuredDeposit)
    ) {
      throw new ValidationError("Deposit amount must match the configured partial payment amount");
    }

    const balanceDue = subtractPrice(orderTotal, configuredDeposit);
    return {
      paymentType: "deposit",
      chargeAmount: configuredDeposit,
      depositAmount: configuredDeposit,
      balanceDue,
    };
  }

  if (paymentType === "balance") {
    const plan = await getPaymentPlan(db, order.id);
    if (plan?.status === "cancelled" || plan?.status === "completed") {
      throw new ValidationError("No balance due");
    }

    const storedBalance = plan?.balanceDue ?? order.balanceDue;
    const balanceDue = roundPrice(Number(storedBalance ?? subtractPrice(orderTotal, Number(order.paidAmount ?? 0))));
    if (order.paymentStatus === PaymentStatus.UNPAID && !plan) {
      throw new ValidationError("No partial payment has been recorded for this order");
    }
    if (!Number.isFinite(balanceDue) || balanceDue <= 0) {
      throw new ValidationError("No balance due");
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
