// The delivery row in a placed order's totals, the same on the receipt and
// the account order page. A free pickup reads "Pickup · <location>", never
// "Delivery Free" or "Shipping Free": nothing was shipped and nothing waived.
import {
  formatCheckoutLanguageText,
  type CheckoutLanguageData,
} from "@scalius/shared/checkout-language";

export interface OrderDeliveryRowInput {
  mode: "ship" | "pickup" | "none";
  /** The saved method: a courier option, or the pickup location's name. */
  methodName?: string | null;
  /** The method's own fee, before any delivery discount. */
  fee: number;
  /** What the buyer paid for it. */
  charged: number;
  /** Codes that saved on delivery, "" for none. */
  codes: string;
}

export interface OrderDeliveryRow {
  label: string;
  value: string;
  /** The fee struck through when a discount lowered it. */
  struck: string | null;
  codes: string;
}

export function orderDeliveryRow(
  input: OrderDeliveryRowInput,
  copy: Pick<CheckoutLanguageData, "orderPickupHeadingText" | "orderReceiptDeliveryText" | "orderReceiptDeliveryWithMethodText" | "freeText">,
  money: (amount: number) => string,
): OrderDeliveryRow {
  const methodName = input.methodName?.trim() || "";
  if (input.mode === "pickup" && input.fee <= 0 && input.charged <= 0) {
    return { label: copy.orderPickupHeadingText, value: methodName, struck: null, codes: "" };
  }
  const label = input.mode === "pickup"
    ? methodName ? `${copy.orderPickupHeadingText} · ${methodName}` : copy.orderPickupHeadingText
    : methodName
      ? formatCheckoutLanguageText(copy.orderReceiptDeliveryWithMethodText, { method: methodName })
      : copy.orderReceiptDeliveryText;
  return {
    label,
    value: input.charged === 0 ? copy.freeText : money(input.charged),
    struck: input.charged < input.fee ? money(input.fee) : null,
    codes: input.codes,
  };
}
