// "Buy again" on an account order (the orders list and the order page): the
// lines still sold go back in the cart at today's price, through the one
// restore path (lib/cart/restore-lines.ts), and the page says what happened
// in its own words.
import { restoreCartLines, type StoredCartLine } from "@/lib/cart/restore-lines";
import { accountCopy } from "@/lib/account-copy";
import { accountMoney, accountOfflineMessage } from "@/lib/account-format";
import { getCustomerOrderDetail } from "@/lib/api/customer-auth";

/** The order's lines (each with its inputs and their surcharges) and their currency, as the order page reads them. */
export interface BuyAgainOrder {
  currencyCode: string | null;
  lines: StoredCartLine[];
}

/** Puts the order's lines in the cart; answers the status to show (empty when there is nothing to say). */
export async function buyAgain(order: BuyAgainOrder): Promise<string> {
  const result = await restoreCartLines(order.lines, { quantity: "add", currencyCode: order.currencyCode });
  const words = accountCopy().orders;
  if (!result) return accountOfflineMessage();
  if ("refused" in result) return result.refused;
  if (result.added === 0) return words.allGone;
  // A line whose price moved went in at today's price: named with it, never dropped.
  const repriced = result.repriced.length > 0
    ? words.pricesChanged(result.repriced.map(({ name, price }) => words.priceChangedLine(name, accountMoney(price, result.currencyCode))).join(words.priceChangedSeparator))
    : "";
  // An input that could not come back (an uploaded photo is bound to its order) is said, with what to do.
  const uncarried = result.uncarried.length > 0
    ? words.inputsNotCarried(
      result.uncarried.map(({ name, inputs }) => words.inputsNotCarriedLine(inputs.join(", "), name)).join(words.priceChangedSeparator),
      result.uncarried.length === 1 && result.uncarried[0]!.inputs.length === 1,
    )
    : "";
  return [result.missing > 0 ? words.someGone : "", repriced, uncarried].filter(Boolean).join(" ");
}

/**
 * Buy again from the orders list: the list knows only the order, so its lines
 * are read whole (inputs and surcharges included, as the order page has
 * them) before they go back, never the list's short summary.
 */
export async function buyAgainOrder(orderId: string): Promise<string> {
  const read = await getCustomerOrderDetail(orderId);
  if (!read.success || !read.detail) return read.unavailable ? accountOfflineMessage() : read.error ?? accountOfflineMessage();
  return buyAgain({ currencyCode: read.detail.order.currencyCode ?? null, lines: read.detail.items });
}
