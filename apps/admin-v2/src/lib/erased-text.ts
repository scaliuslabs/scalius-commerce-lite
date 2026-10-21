import { isErasedText } from "@scalius/shared/customer-erasure";

/**
 * A stored text as the dashboard shows it: the erasure marker ("[erased]",
 * written when a customer's personal data is erased) reads as the translated
 * `label` ("Erased customer", "Erased"); anything else is shown as it is.
 */
export function shownText<T extends string | null | undefined>(value: T, label: string): T | string {
  return isErasedText(value) ? label : value;
}
