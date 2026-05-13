import { describe, expect, it } from "vitest";
import {
  groupReservationEntriesByOrder,
  type QueuedReservationEntry,
} from "../../../../packages/core/src/modules/orders/orders.queue";

describe("order ingest queue reservation grouping", () => {
  it("groups rollback entries by original order id", () => {
    const entries: QueuedReservationEntry[] = [
      { orderId: "ord_1", variantId: "var_a", quantity: 1, pool: "regular" },
      { orderId: "ord_2", variantId: "var_b", quantity: 2, pool: "preorder" },
      { orderId: "ord_1", variantId: "var_c", quantity: 3, pool: "regular" },
    ];

    expect([...groupReservationEntriesByOrder(entries).entries()]).toEqual([
      [
        "ord_1",
        [
          { orderId: "ord_1", variantId: "var_a", quantity: 1, pool: "regular" },
          { orderId: "ord_1", variantId: "var_c", quantity: 3, pool: "regular" },
        ],
      ],
      [
        "ord_2",
        [
          { orderId: "ord_2", variantId: "var_b", quantity: 2, pool: "preorder" },
        ],
      ],
    ]);
  });
});
