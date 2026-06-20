import type { CustomerPaymentRecovery } from "./api/customer-auth";

export type AccountPaymentRecoveryAction = {
  visible: boolean;
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
  if (paymentType === "balance") return "Remaining balance is due";
  if (paymentType === "deposit") return "Advance payment is due";
  return "Payment needs attention";
}

function recoveryDescription(paymentType: CustomerPaymentRecovery["paymentType"]): string {
  if (paymentType === "balance") {
    return "Complete the remaining online payment for this order.";
  }
  if (paymentType === "deposit") {
    return "Pay the required advance to keep this order moving.";
  }
  return "Retry the online payment for this order.";
}

function recoveryButtonLabel(recovery: CustomerPaymentRecovery): string {
  if (recovery.requiresCardForm) return "Enter card details";
  if (recovery.paymentType === "balance") return "Pay balance";
  return recovery.label || "Retry payment";
}

export function getAccountPaymentRecoveryAction(
  recovery: CustomerPaymentRecovery | null | undefined,
): AccountPaymentRecoveryAction | null {
  if (!recovery?.eligible || !recovery.gateway || !recovery.paymentType) {
    return null;
  }

  return {
    visible: true,
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
  if (gateway !== "sslcommerz" && gateway !== "polar" && gateway !== "stripe") {
    return null;
  }

  const normalizedResult = normalize(result);
  if (normalizedResult === "cancelled") {
    return {
      tone: "warning",
      title: "Payment was cancelled",
      message: "Your order is still saved. You can retry payment from this page.",
    };
  }

  if (normalizedResult === "failed") {
    return {
      tone: "warning",
      title: "Payment did not complete",
      message: "The gateway reported a failed payment. You can retry when ready.",
    };
  }

  return {
    tone: "info",
    title: "Payment submitted",
    message: "We are checking the gateway confirmation. This page will show the latest payment status.",
  };
}

export function normalizeHostedGatewayUrl(url: string | null | undefined): string | null {
  const raw = url?.trim();
  if (!raw || !/^https?:\/\//i.test(raw)) return null;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.href;
  } catch {
    return null;
  }
}
