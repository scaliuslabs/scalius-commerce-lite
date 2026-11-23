// Test-only: orders for the nightly sales-stats refresh, as SQL both engines
// run (sales-stats-refresh.d1.test.ts, sales-stats-refresh.postgres-native.test.ts).
// Plain lines with accepted, rejected and cancelled returns; void orders; and
// a store kit, sold as its items' lines with the kit on its anchor's `_bundle`
// entry: one order of 3 kits whose anchor item is split over two lines, one
// of 2 kits with one kit returned.

/** A kit line's frozen `_bundle` entry, as checkout serialises it (`lineBundleProperty`). */
function kitEntry(bundleId: string, anchor: boolean, units: number, perUnit: number): string {
    return JSON.stringify([{
        key: "_bundle", type: "text", label: "Bundle", value: "Tea set", displayValue: "Tea set", priceMinor: 0,
        bundle: { id: bundleId, kind: "kit", kit: { variantId: "var_kit", productId: "prod_kit" }, anchor, units, perUnit },
    }]).replaceAll("'", "''");
}

export function salesStatsSeed(now: number): string {
    const day = now - 86_400;
    return `
        INSERT INTO products (id, name, price_minor, slug, is_active) VALUES
            ('prod_kept', 'Kept', 1000, 'kept', 1), ('prod_back', 'Back', 1000, 'back', 1), ('prod_void', 'Void', 1000, 'void', 1),
            ('prod_kit', 'Tea set', 3000, 'tea-set', 1), ('prod_tea', 'Tea', 1000, 'tea', 1), ('prod_cup', 'Cup', 1000, 'cup', 1);
        INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status, created_at, updated_at) VALUES
            ('ord_kept', 'A', '01711000001', 'Road', 'c', 'z', 'delivered', ${day}, ${day}),
            ('ord_cancel', 'B', '01711000002', 'Road', 'c', 'z', 'cancelled', ${day}, ${day}),
            ('ord_refund', 'C', '01711000003', 'Road', 'c', 'z', 'refunded', ${day}, ${day}),
            ('ord_kits', 'D', '01711000004', 'Road', 'c', 'z', 'confirmed', ${day}, ${day}),
            ('ord_kit_back', 'E', '01711000005', 'Road', 'c', 'z', 'delivered', ${day}, ${day});
        INSERT INTO order_items (id, order_id, product_id, quantity, fulfillment_type, properties) VALUES
            ('line_kept', 'ord_kept', 'prod_kept', 4, 'ship', NULL), ('line_back', 'ord_kept', 'prod_back', 2, 'ship', NULL),
            ('line_cancel', 'ord_cancel', 'prod_void', 5, 'ship', NULL), ('line_refund', 'ord_refund', 'prod_void', 5, 'ship', NULL),
            ('line_tea_light', 'ord_kits', 'prod_tea', 3, 'ship', '${kitEntry("cart:0:var_kit", true, 3, 1)}'),
            ('line_tea_heavy', 'ord_kits', 'prod_tea', 3, 'ship', '${kitEntry("cart:0:var_kit", true, 3, 1)}'),
            ('line_cup', 'ord_kits', 'prod_cup', 3, 'ship', '${kitEntry("cart:0:var_kit", false, 3, 1)}'),
            ('line_tea_back', 'ord_kit_back', 'prod_tea', 4, 'ship', '${kitEntry("cart:0:var_kit", true, 2, 2)}'),
            ('line_cup_back', 'ord_kit_back', 'prod_cup', 2, 'ship', '${kitEntry("cart:0:var_kit", false, 2, 1)}');
        INSERT INTO order_fulfillments (id, order_id, kind, request_key, actor_type) VALUES
            ('ful_kept', 'ord_kept', 'ship', 'key_kept', 'admin'), ('ful_kit_back', 'ord_kit_back', 'ship', 'key_kit_back', 'admin');
        INSERT INTO order_fulfillment_lines (id, fulfillment_id, order_id, order_item_id, quantity) VALUES
            ('fln_kept', 'ful_kept', 'ord_kept', 'line_kept', 4), ('fln_back', 'ful_kept', 'ord_kept', 'line_back', 2),
            ('fln_tea_back', 'ful_kit_back', 'ord_kit_back', 'line_tea_back', 4), ('fln_cup_back', 'ful_kit_back', 'ord_kit_back', 'line_cup_back', 2);
        INSERT INTO order_returns (id, order_id, status, reason, actor_type) VALUES
            ('ret_done', 'ord_kept', 'completed', 'Too small', 'admin'),
            ('ret_refused', 'ord_kept', 'rejected', 'Changed mind', 'admin'),
            ('ret_withdrawn', 'ord_kept', 'cancelled', 'Kept it after all', 'admin'),
            ('ret_kit', 'ord_kit_back', 'approved', 'One set broke', 'admin');
        INSERT INTO order_return_lines (id, return_id, order_id, order_item_id, inventory_tracked, requested_quantity, approved_quantity) VALUES
            ('rl_kept', 'ret_done', 'ord_kept', 'line_kept', 0, 1, 1),
            ('rl_back', 'ret_done', 'ord_kept', 'line_back', 0, 2, 2),
            ('rl_refused', 'ret_refused', 'ord_kept', 'line_kept', 0, 2, 2),
            ('rl_withdrawn', 'ret_withdrawn', 'ord_kept', 'line_kept', 0, 1, 1),
            ('rl_kit_tea', 'ret_kit', 'ord_kit_back', 'line_tea_back', 0, 2, 2),
            ('rl_kit_cup', 'ret_kit', 'ord_kit_back', 'line_cup_back', 0, 1, 1);
    `;
}

/**
 * What the refresh stores. prod_kept: 4 sold, 1 accepted back (the rejected
 * and the withdrawn return count as sold). prod_back: returned in full. The
 * void orders: nothing. prod_kit: 3 kits (the split anchor counts them once)
 * plus 2 kits less the 1 returned. Its items keep their own units: tea 6 + 4
 * less 2 returned, cups 3 + 2 less 1.
 */
export const SALES_STATS_EXPECTED = [
    { product_id: "prod_cup", sold_30d: 4 },
    { product_id: "prod_kept", sold_30d: 3 },
    { product_id: "prod_kit", sold_30d: 4 },
    { product_id: "prod_tea", sold_30d: 8 },
];
