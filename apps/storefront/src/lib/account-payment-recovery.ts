import type { CustomerPaymentRecovery } from "./api/customer-auth";
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

function recoveryTitle(paymentType: CustomerPaymentRecovery["paymentType"]): string {
  const words = accountCopy().recovery;
  if (paymentType === "balance") return words.balanceTitle;
  if (paymentType === "deposit") return words.depositTitle;
  return words.retryTitle;
}

function recoveryDescription(paymentType: CustomerPaymentRecovery["paymentType"]): string {
  const words = accountCopy().recovery;
  if (paymentType === "balance") return words.balanceText;
  if (paymentType === "deposit") return words.depositText;
  return words.retryText;
}

function recoveryButtonLabel(recovery: CustomerPaymentRecovery): string {
  const words = accountCopy().recovery;
  if (recovery.requiresCardForm) return words.enterCard;
  if (recovery.paymentType === "balance") return words.payBalance;
  return recovery.label || words.retryPayment;
}

export function getAccountPaymentRecoveryAction(
  recovery: CustomerPaymentRecovery | null | undefined,
): AccountPaymentRecoveryAction | null {
  if (!recovery?.eligible || !recovery.gateway || !recovery.paymentType) {
    return null;
  }

  return {
    visible: true,
    gateway: recovery.gateway,
    title: recoveryTitle(recovery.paymentType),
    description: recoveryDescription(recovery.paymentType),
    buttonLabel: recoveryButtonLabel(recovery),
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
