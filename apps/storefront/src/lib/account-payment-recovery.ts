import type { CustomerPaymentRecovery } from "./api/customer-auth";
import type { BuyerOrderDetailView } from "@scalius/shared/buyer-order-view";
import { normalizeHostedCheckoutUrl } from "./checkout/redirect-url";
import { isPaymentMethodIdShape } from "./payment-method-id";
import { accountCopy } from "./account-copy";

export type AccountPaymentRecoveryAction = {
  visible: boolean;
  gateway: string;
  title: string;
  description: string;
  buttonLabel: string;
  amountDue: number;
  requiresCardForm: boolean;
  hostedRedirect: boolean;
};

export type AccountPaymentReturnNotice = {
  tone: "info" | "warning" | "success";
  title: string;
  message: string;
} | null;

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

type PaymentAction = NonNullable<BuyerOrderDetailView["paymentAction"]>;

/** Paying a placed order's balance early is never worded as a retry. */
function recoveryTitle(action: PaymentAction, paymentType: CustomerPaymentRecovery["paymentType"]): string {
  const words = accountCopy().recovery;
  if (action === "pay_balance") return words.balanceTitle;
  if (paymentType === "deposit") return words.depositTitle;
  return words.retryTitle;
}

function recoveryDescription(action: PaymentAction, paymentType: CustomerPaymentRecovery["paymentType"]): string {
  const words = accountCopy().recovery;
  if (action === "pay_balance") return words.balanceText;
  if (paymentType === "deposit") return words.depositText;
  return words.retryText;
}

function recoveryButtonLabel(action: PaymentAction, recovery: CustomerPaymentRecovery): string {
  const words = accountCopy().recovery;
  if (recovery.requiresCardForm) return words.enterCard;
  return action === "pay_balance" ? words.payBalance : words.retryPayment;
}

/** The account's payment card, for the payment the API's view says the buyer may make. */
export function getAccountPaymentRecoveryAction(
  recovery: CustomerPaymentRecovery | null | undefined,
  action: BuyerOrderDetailView["paymentAction"],
): AccountPaymentRecoveryAction | null {
  if (!action || !recovery?.eligible || !recovery.gateway || !recovery.paymentType) {
    return null;
  }

  return {
    visible: true,
    gateway: recovery.gateway,
    title: recoveryTitle(action, recovery.paymentType),
    description: recoveryDescription(action, recovery.paymentType),
    buttonLabel: recoveryButtonLabel(action, recovery),
    amountDue: recovery.amountDue,
    requiresCardForm: recovery.requiresCardForm,
    hostedRedirect: recovery.hostedRedirect,
  };
}

export function getAccountPaymentReturnNotice(
  payment: string | null | undefined,
  result: string | null | undefined,
): AccountPaymentReturnNotice {
  const gateway = normalize(payment);
  if (!isPaymentMethodIdShape(gateway) || gateway === "cod") {
    return null;
  }

  const normalizedResult = normalize(result);
  const words = accountCopy().recovery;
  if (normalizedResult === "cancelled") {
    return { tone: "warning", title: words.cancelledTitle, message: words.cancelledText };
  }

  if (normalizedResult === "failed") {
    return { tone: "warning", title: words.failedTitle, message: words.failedText };
  }

  return { tone: "info", title: words.submittedTitle, message: words.submittedText };
}

export function normalizeHostedGatewayUrl(url: string | null | undefined): string | null {
  return normalizeHostedCheckoutUrl(url);
}
