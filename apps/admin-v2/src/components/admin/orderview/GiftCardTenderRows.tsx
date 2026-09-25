// Owned by B4 (gift cards): the gift-card tenders in the payment summary (rows of its <dl>); nothing until B4 ships it.
import type { OrderPaymentsPayload } from "~/lib/api-query-options/orders";
import type { Order } from "./types";

export function GiftCardTenderRows(_props: {
  order: Order;
  /** The payments read (empty until it loads); gift-card tenders are `order_payments` rows. */
  payments: ReadonlyArray<OrderPaymentsPayload["payments"][number]>;
}): null {
  return null;
}
