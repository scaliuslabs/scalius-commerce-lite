import { formatStoreDateTime, storeTimeZone } from "./store-time-zone";
import type {
  OrderReceiptSupportRequest,
  OrderReceiptSupportRequestType,
} from "./api/types";
import {
  checkoutLanguageBaseCode,
  formatCheckoutLanguageText,
  type CheckoutLanguageData,
} from "@scalius/shared/checkout-language";
import {
  appGatewayName,
  SSLCOMMERZ_GATEWAY_ID,
  sslcommerzPresentation,
  type GatewayPresentation,
} from "./checkout/gateway-presentation";

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function formatOrderReceiptDate(
  value: string | null | undefined,
  languageCode: string,
  timeZone: string = storeTimeZone(),
): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return formatStoreDateTime(date, checkoutLanguageBaseCode(languageCode), { dateStyle: "medium", timeStyle: "short" }, timeZone);
}

export function formatOrderSuccessLabel(
  value: string | null | undefined,
  copy: CheckoutLanguageData,
): string {
  const labels: Record<string, string> = {
    pending: copy.orderReceiptStatusPendingText,
    incomplete: copy.orderReceiptStatusIncompleteText,
    confirmed: copy.orderReceiptStatusConfirmedText,
    processing: copy.orderReceiptStatusProcessingText,
    shipped: copy.orderReceiptStatusShippedText,
    delivered: copy.orderReceiptStatusDeliveredText,
    completed: copy.orderReceiptStatusCompletedText,
    cancelled: copy.orderReceiptStatusCancelledText,
    refunded: copy.orderReceiptStatusRefundedText,
    returned: copy.orderReceiptStatusReturnedText,
    partially_refunded: copy.orderReceiptStatusPartiallyRefundedText,
    failed: copy.orderReceiptStatusFailedText,
    paid: copy.orderReceiptPaymentStatusPaidText,
    partial: copy.orderReceiptPaymentStatusPartialText,
    unpaid: copy.orderReceiptPaymentStatusUnpaidText,
  };
  return labels[normalize(value)] ?? copy.orderReceiptStatusNotAvailableText;
}

/**
 * The order's payment method in the buyer's words. Cash is named for where it
 * is paid: on delivery, at pickup, or on service (nothing is delivered).
 */
export function formatOrderSuccessPaymentMethod(
  value: string | null | undefined,
  copy: CheckoutLanguageData,
  delivery?: { shippingMethodKind?: string | null; requiresShipping?: boolean | null },
  /** The store's checkout gateways, for an app wallet's checkout name. */
  gateways?: readonly { id: string; name?: unknown }[] | null,
): string {
  switch (normalize(value)) {
    case "cod":
      if (delivery?.shippingMethodKind === "pickup") return copy.orderReceiptPaymentMethodPayAtPickupText;
      if (delivery?.requiresShipping === false) return copy.orderReceiptPaymentMethodPayOnServiceText;
      return copy.cashOnDeliveryText;
    case "stripe":
      return copy.orderReceiptPaymentMethodCardText;
    // SSLCommerz, the Bangladesh pack's (stored as `sslcommerz` before it moved there).
    case "sslcommerz":
    case SSLCOMMERZ_GATEWAY_ID:
      return copy.orderReceiptPaymentMethodSslcommerzText;
    default:
      // An app's wallet (`<plugin id>:<provider id>`) by its checkout name.
      return appGatewayName(normalize(value), gateways) ?? copy.orderReceiptStatusNotAvailableText;
  }
}

export function localizeOrderReceiptGatewayPresentation(
  gatewayId: string,
  presentation: GatewayPresentation,
  copy: CheckoutLanguageData,
): GatewayPresentation {
  switch (gatewayId) {
    case "stripe":
      return {
        ...presentation,
        buyerLabel: copy.creditDebitCardText,
        description: copy.paySecurelyByCardText,
      };
    case "sslcommerz":
    case SSLCOMMERZ_GATEWAY_ID:
      return sslcommerzPresentation(presentation, copy);
    case "cod":
      return {
        ...presentation,
        buyerLabel: copy.cashOnDeliveryText,
        description: copy.payOnDeliveryText,
      };
    default:
      return presentation;
  }
}

export function getOrderReceiptSupportActionLabel(
  type: OrderReceiptSupportRequestType,
  copy: CheckoutLanguageData,
): string {
  switch (type) {
    case "cancel_pre_shipment":
      return copy.orderReceiptCancelRequestActionText;
    case "return":
      return copy.orderReceiptReturnRequestActionText;
    case "refund":
      return copy.orderReceiptRefundRequestActionText;
  }
}

export function getOrderReceiptSupportStatusLabel(
  status: string,
  copy: CheckoutLanguageData,
): string {
  switch (normalize(status)) {
    case "submitted":
      return copy.orderReceiptRequestStatusSubmittedText;
    case "under_review":
      return copy.orderReceiptRequestStatusUnderReviewText;
    case "approved":
      return copy.orderReceiptRequestStatusApprovedText;
    case "rejected":
      return copy.orderReceiptRequestStatusRejectedText;
    case "withdrawn":
      return copy.orderReceiptRequestStatusWithdrawnText;
    case "completed":
      return copy.orderReceiptRequestStatusCompletedText;
    default:
      return copy.orderReceiptStatusNotAvailableText;
  }
}

export function getOrderReceiptSupportRequestLabel(
  request: Pick<OrderReceiptSupportRequest, "type" | "status">,
  copy: CheckoutLanguageData,
): string {
  return formatCheckoutLanguageText(copy.orderReceiptRequestLabelText, {
    action: getOrderReceiptSupportActionLabel(request.type, copy),
    status: getOrderReceiptSupportStatusLabel(request.status, copy),
  });
}

export function getOrderReceiptSupportStatusMessage(
  request: Pick<OrderReceiptSupportRequest, "status" | "active">,
  copy: CheckoutLanguageData,
): string {
  switch (normalize(request.status)) {
    case "submitted":
      return copy.orderReceiptRequestSubmittedText;
    case "under_review":
      return copy.orderReceiptRequestUnderReviewText;
    case "approved":
      return copy.orderReceiptRequestApprovedText;
    case "rejected":
      return copy.orderReceiptRequestRejectedText;
    case "withdrawn":
      return copy.orderReceiptRequestWithdrawnText;
    case "completed":
      return copy.orderReceiptRequestCompletedText;
    default:
      return request.active
        ? copy.orderReceiptRequestUnderReviewText
        : copy.orderReceiptRequestSettledText;
  }
}

const SUPPORT_STATUSES_WITH_NEXT_STEP = new Set(["submitted", "under_review", "approved", "withdrawn", "completed"]);

/** A declined or settled request leaves the buyer nowhere to go but the store itself. */
export function orderReceiptSupportRequestNeedsStoreContact(
  request: Pick<OrderReceiptSupportRequest, "status" | "active">,
): boolean {
  const status = normalize(request.status);
  if (status === "rejected") return true;
  return !SUPPORT_STATUSES_WITH_NEXT_STEP.has(status) && !request.active;
}
