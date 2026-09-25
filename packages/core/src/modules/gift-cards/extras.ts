import type { Database } from "@scalius/database/client";
import type { LineExtrasInput } from "../../utils/line-extras";
import type { LineGiftCardExtra } from "./browser";

/**
 * Gift cards each order line issued, keyed by order item id (`extras.giftCards`).
 * Stub until B4 fills it: no I/O, always empty.
 */
export async function listLineIssuedCards(
  _db: Database,
  _input: LineExtrasInput,
): Promise<ReadonlyMap<string, readonly LineGiftCardExtra[]>> {
  return new Map();
}

/**
 * Gift cards saved to the signed-in customer (the account "Gift cards" count).
 * Stub until B4 fills it: no I/O, always 0.
 */
export async function countBuyerGiftCards(
  _db: Database,
  _customerId: string,
): Promise<number> {
  return 0;
}
