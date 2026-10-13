import { NotFoundError } from "./api-error";
import type { Database } from "@scalius/database/client";
import {
  isOrderReceiptToken,
  validateOrderReceiptProof,
} from "@scalius/core/modules/orders";

/** Receipt proof is authorised by the relational database alone. */
export async function validateReceiptToken(
  db: Database,
  orderId: string,
  token: string | undefined,
): Promise<void> {
  if (!isOrderReceiptToken(token)) {
    throw new NotFoundError("Order receipt not found");
  }
  const result = await validateOrderReceiptProof(db, { orderId, token });
  if (!result) {
    throw new NotFoundError("Order receipt not found");
  }
}
