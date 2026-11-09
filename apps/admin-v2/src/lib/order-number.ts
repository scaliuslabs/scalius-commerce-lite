import { formatOrderNumberIn } from "@scalius/shared/order-utils";
import { dashboardNumberLocale } from "~/i18n";

/**
 * An order's number as the dashboard reads it: "#১০১৭" in Bangla, "#1017"
 * in English (`formatOrderNumberIn`: an order number takes the reader's
 * digits on every surface written in a language; ids keep theirs).
 */
export function formatOrderNumber(orderNumber: number | null | undefined, fallbackId: string): string {
  return formatOrderNumberIn(orderNumber, fallbackId, dashboardNumberLocale());
}
