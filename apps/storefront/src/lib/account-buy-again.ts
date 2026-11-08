// "Buy again" on an account order (the orders list and the order page): the
// lines still sold go back in the cart at today's price, through the one
// restore path (lib/cart/restore-lines.ts), and the page says what happened
// in its own words.
import { restoreCartLines, type StoredCartLine } from "@/lib/cart/restore-lines";
import { accountCopy } from "@/lib/account-copy";
import { accountMoney, accountOfflineMessage } from "@/lib/account-format";

/** The order's lines and their currency, as the orders list embeds them (`data-buy-again`). */
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
    ? words.pricesChanged(result.repriced.map(({ name, price }) => ({ name, price: accountMoney(price, result.currencyCode) })))
    : "";
  return [result.missing > 0 ? words.someGone : "", repriced].filter(Boolean).join(" ");
}
