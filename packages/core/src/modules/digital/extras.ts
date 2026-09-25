import type { Database } from "@scalius/database/client";
import type { LineExtrasInput } from "../../utils/line-extras";
import type { LineDigitalExtra } from "./browser";

/**
 * Downloads and licence keys per order line, keyed by order item id
 * (`extras.downloads`, `extras.licenceKeys`).
 * Stub until B3 fills it: no I/O, always empty.
 */
export async function listLineDeliveries(
  _db: Database,
  _input: LineExtrasInput,
): Promise<ReadonlyMap<string, LineDigitalExtra>> {
  return new Map();
}

/**
 * Downloads available to the signed-in customer (the account "Downloads" count).
 * Stub until B3 fills it: no I/O, always 0.
 */
export async function countBuyerDownloads(
  _db: Database,
  _customerId: string,
): Promise<number> {
  return 0;
}
