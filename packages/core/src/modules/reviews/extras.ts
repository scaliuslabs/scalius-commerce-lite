import type { Database } from "@scalius/database/client";
import type { LineExtrasInput } from "../../utils/line-extras";
import type { LineReviewExtra } from "./browser";

/**
 * Review state per order line, keyed by order item id (`extras.review`).
 * Stub until B1 fills it: no I/O, always empty.
 */
export async function listLineReviewStates(
  _db: Database,
  _input: LineExtrasInput,
): Promise<ReadonlyMap<string, LineReviewExtra>> {
  return new Map();
}

/**
 * Lines the signed-in customer can still review (the account "Reviews" count).
 * Stub until B1 fills it: no I/O, always 0.
 */
export async function countReviewableLinesForCustomer(
  _db: Database,
  _customerId: string,
): Promise<number> {
  return 0;
}
