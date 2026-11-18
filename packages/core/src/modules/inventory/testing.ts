// Test fixtures only. An order's stock hold is its ledger: a release or
// deduct needs the order's own reserve movement (rules/inventory/
// release-and-deduct-need-open-reservation.md), so a seeded "reserved" order
// gets one, with the counters it moved.

/**
 * SQL that reserves `quantity` of a SKU for an order as checkout does: one
 * ledger-v2 `reserved` edge from the SKU's current counters, and the counters
 * moved with it.
 */
export function seedOrderReservationSql(input: {
    orderId: string;
    variantId: string;
    quantity: number;
    pool?: "regular" | "backorder";
    generation?: number;
}): string {
    const pool = input.pool ?? "regular";
    const generation = input.generation ?? 1;
    const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
    return `
        INSERT INTO inventory_movements (
          id, variant_id, order_id, type, quantity, previous_stock, new_stock, ledger_version, pool,
          reservation_generation, stock_version_before, stock_version_after, stock_delta,
          previous_reserved_stock, new_reserved_stock, reserved_stock_delta,
          previous_preorder_stock, new_preorder_stock, preorder_stock_delta, created_at
        )
        SELECT ${quote(`seed_reserve:${input.orderId}:${input.variantId}:${generation}`)}, id, ${quote(input.orderId)}, 'reserved',
          ${input.quantity}, stock, stock, 2, ${quote(pool)}, ${generation}, stock_version, stock_version + 1, 0,
          reserved_stock, reserved_stock + ${input.quantity}, ${input.quantity},
          preorder_stock, preorder_stock, 0, unixepoch()
        FROM product_variants WHERE id = ${quote(input.variantId)};
        UPDATE product_variants
        SET reserved_stock = reserved_stock + ${input.quantity}, stock_version = stock_version + 1
        WHERE id = ${quote(input.variantId)};
    `;
}
