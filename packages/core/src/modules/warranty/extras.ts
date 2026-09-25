import type { Database } from "@scalius/database/client";
import type { LineExtrasInput } from "../../utils/line-extras";
import type { LineWarrantyExtra } from "./browser";

/**
 * Warranty records per order line, keyed by order item id (`extras.warranty`).
 * Stub until B5 fills it: no I/O, always empty.
 */
export async function listLineWarranties(
  _db: Database,
  _input: LineExtrasInput,
): Promise<ReadonlyMap<string, readonly LineWarrantyExtra[]>> {
  return new Map();
}

/**
 * Active (not voided, not expired) warranties of the signed-in customer
 * (the account "Warranties" count).
 * Stub until B5 fills it: no I/O, always 0.
 */
export async function countActiveBuyerWarranties(
  _db: Database,
  _customerId: string,
): Promise<number> {
  return 0;
}
