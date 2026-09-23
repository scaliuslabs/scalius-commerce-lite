// Money, stock, and identity rules the migrated schema itself must refuse to
// break, exercised against the real migration chain rather than its text.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";

import * as schema from "../src/schema";
import { createMigratedSqlite } from "../src/testing/sqlite-d1";

type Row = Record<string, SQLInputValue>;

function inserter(sqlite: DatabaseSync) {
  return (table: string, row: Row) => {
    const columns = Object.keys(row);
    sqlite
      .prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
      .run(...Object.values(row));
  };
}

describe("migrated schema invariants", () => {
  it("keeps SKU identity, default SKUs, same-product SKU images, and inventory history intact", () => {
    const sqlite = createMigratedSqlite();
    const insert = inserter(sqlite);
    for (const id of ["prod_a", "prod_b"]) insert("products", { id, name: id, price: 100, slug: id });
    insert("media", {
      id: "med_a", filename: "a.jpg", kind: "image", object_key: "demo/a.jpg", size: 1, mime_type: "image/jpeg",
    });
    insert("product_media", { id: "pmed_a_image", product_id: "prod_a", media_id: "med_a", sort_order: 0 });
    const variant = (id: string, productId: string, sku: string, extra: Row = {}) =>
      insert("product_variants", { id, product_id: productId, sku, price: 100, is_default: 1, ...extra });

    variant("var_a", "prod_a", "SKU-1", { image_id: "pmed_a_image" });
    expect(() => variant("var_b", "prod_b", "sku-1")).toThrow(/product_variants_sku_identity_uidx/);
    expect(() => variant("var_a2", "prod_a", "SKU-2")).toThrow(/UNIQUE constraint failed: product_variants\.product_id/);
    expect(() => variant("var_b", "prod_b", "SKU-3", { image_id: "pmed_a_image" }))
      .toThrow(/INVALID_PRODUCT_VARIANT_IDENTITY/);

    sqlite.exec("DELETE FROM product_media WHERE id = 'pmed_a_image'");
    expect(sqlite.prepare("SELECT image_id FROM product_variants WHERE id = 'var_a'").get())
      .toEqual({ image_id: null });

    insert("inventory_movements", {
      id: "mov_1", variant_id: "var_a", type: "adjusted", quantity: 1, previous_stock: 0, new_stock: 1,
    });
    expect(() => sqlite.exec("DELETE FROM product_variants WHERE id = 'var_a'")).toThrow(/FOREIGN KEY/);
    expect(() => sqlite.exec("DELETE FROM products WHERE id = 'prod_a'")).toThrow(/FOREIGN KEY/);

    sqlite.exec("UPDATE product_variants SET deleted_at = unixepoch() WHERE id = 'var_a'");
    variant("var_a2", "prod_a", "SKU-2");
    insert("inventory_operations", {
      operation_key: "op_1", request_hash: "h", operation_type: "adjust", variant_id: "var_a2",
      result_payload: "{}", stock_version_before: 1, stock_version_after: 2,
    });
    expect(() => insert("inventory_operations", {
      operation_key: "op_1", request_hash: "h2", operation_type: "adjust", variant_id: "var_a2",
      result_payload: "{}", stock_version_before: 2, stock_version_after: 3,
    })).toThrow(/UNIQUE constraint failed: inventory_operations\.operation_key/);
  });

  it("keeps SKU images as direct references with no retired URL-copy or mapping authority", () => {
    const sqlite = createMigratedSqlite();
    const names = (sql: string) => sqlite.prepare(sql).all().map((row) => row.name);
    const tables = names("SELECT name FROM sqlite_master WHERE type = 'table'");

    expect(tables).toContain("product_media");
    expect(tables).not.toContain("product_images");
    expect(tables).not.toContain("product_variant_image_mappings");
    expect(names("SELECT name FROM pragma_table_info('products')")).not.toContain("variant_image_axis");
    expect(schema).not.toHaveProperty("productImages");
    expect(schema).not.toHaveProperty("productVariantImageMappings");
  });

  it("allows one live refund per source payment and one row per provider refund", () => {
    const sqlite = createMigratedSqlite();
    sqlite.exec("PRAGMA foreign_keys = OFF"); // parents are irrelevant to these guards
    const insert = inserter(sqlite);
    const attempt = (id: string, status: string, extra: Row = {}) => insert("refund_attempts", {
      id, attempt_key: id, refund_group_id: id, order_id: "ord_1", source_payment_id: "pay_1",
      refund_payment_id: `refund_${id}`, gateway: "stripe", amount: 10, reason: "requested",
      request_hash: id, provider_idempotency_key: id, refund_reference: id, status, ...extra,
    });

    attempt("ra_1", "pending", { provider_refund_id: "re_1" });
    for (const status of ["pending", "processing", "provider_unknown", "reconcile_required"]) {
      expect(() => attempt("ra_2", status)).toThrow(/UNIQUE constraint failed: refund_attempts\.source_payment_id/);
    }

    sqlite.exec("UPDATE refund_attempts SET status = 'refunded' WHERE id = 'ra_1'");
    attempt("ra_2", "pending");
    expect(() => attempt("ra_3", "failed", { provider_refund_id: "re_1" }))
      .toThrow(/UNIQUE constraint failed: refund_attempts\.gateway, refund_attempts\.provider_refund_id/);
  });

  it("issues one immutable invoice per order under a globally idempotent command", () => {
    const sqlite = createMigratedSqlite();
    sqlite.exec("PRAGMA foreign_keys = OFF"); // parents are irrelevant to these guards
    const insert = inserter(sqlite);
    const invoice = (id: string, orderId: string, number: number) => insert("order_invoices", {
      id, order_id: orderId, invoice_number: number, prefix: "INV", formatted_number: `INV-${id}`,
      order_version: 1, snapshot: "{}", content_hash: "a".repeat(64), render_version: "1", issued_at: 1,
    });
    const command = (id: string, invoiceId: string) => insert("invoice_issue_commands", {
      id, operation_key: "issue-key-1", request_hash: "b".repeat(64), order_id: "ord_1", invoice_id: invoiceId,
    });

    invoice("inv_1", "ord_1", 1);
    command("cmd_1", "inv_1");
    expect(() => invoice("inv_2", "ord_1", 2)).toThrow(/order_invoices\.order_id/);
    expect(() => invoice("inv_2", "ord_2", 1)).toThrow(/order_invoices\.invoice_number/);
    expect(() => command("cmd_2", "inv_1")).toThrow(/invoice_issue_commands\.operation_key/);
    for (const statement of [
      "UPDATE order_invoices SET snapshot = '[]'",
      "DELETE FROM order_invoices",
      "UPDATE invoice_issue_commands SET actor_id = 'x'",
      "DELETE FROM invoice_issue_commands",
    ]) {
      expect(() => sqlite.exec(statement), statement).toThrow(/immutable/);
    }
  });

  it("bounds cumulative returns by the shipped quantity and requires restock movement evidence", () => {
    const sqlite = createMigratedSqlite();
    sqlite.exec("PRAGMA foreign_keys = OFF"); // parents are irrelevant to these guards
    const insert = inserter(sqlite);
    insert("orders", {
      id: "ord_1", customer_name: "Buyer", customer_phone: "01700000000", shipping_address: "Road 1",
      city: "c", zone: "z", total_amount: 200, shipping_charge: 0,
    });
    insert("order_items", {
      id: "item_1", order_id: "ord_1", product_id: "prod_1", variant_id: "var_1", quantity: 2, price: 100,
      fulfillment_status: "shipped",
    });
    const returnCase = (id: string) =>
      insert("order_returns", { id, order_id: "ord_1", reason: "damaged", actor_type: "admin" });
    const line = (id: string, returnId: string, quantity: number) => insert("order_return_lines", {
      id, return_id: returnId, order_id: "ord_1", order_item_id: "item_1", variant_id: "var_1",
      requested_quantity: quantity,
    });

    returnCase("ret_1");
    returnCase("ret_2");
    line("line_1", "ret_1", 1);
    expect(() => line("line_2", "ret_2", 2)).toThrow(/cumulative return quantity exceeds/);
    line("line_2", "ret_2", 1);
    expect(() => sqlite.exec("DELETE FROM order_return_lines WHERE id = 'line_1'")).toThrow(/durable order evidence/);
    expect(() => sqlite.exec("DELETE FROM order_returns WHERE id = 'ret_1'")).toThrow(/durable order evidence/);

    sqlite.exec(`
      UPDATE order_returns SET status = 'approved' WHERE id = 'ret_1';
      UPDATE order_return_lines SET approved_quantity = 1 WHERE id = 'line_1';
      UPDATE order_returns SET status = 'receiving', active_order_key = 'ord_1', active_command_key = 'receive-key-1',
        active_command_hash = 'hash', active_command_type = 'receive', active_command_started_at = 1
      WHERE id = 'ret_1';
    `);
    insert("order_return_commands", {
      id: "rcmd_1", order_id: "ord_1", return_id: "ret_1", command_key: "receive-key-1", command_type: "receive",
      request_hash: "hash", request_payload: "{}", actor_type: "admin",
    });
    const receipt = (movementId: string) => insert("order_return_receipt_lines", {
      id: "receipt_1", command_id: "rcmd_1", return_id: "ret_1", return_line_id: "line_1", order_id: "ord_1",
      variant_id: "var_1", received_quantity: 1, restock_quantity: 1, damaged_quantity: 0, actor_type: "admin",
      inventory_movement_id: movementId,
    });

    expect(() => receipt("mov_missing")).toThrow(/lacks matching inventory movement evidence/);
    insert("inventory_movements", {
      id: "mov_restored", variant_id: "var_1", order_id: "ord_1", type: "restored", quantity: 1,
      previous_stock: 0, new_stock: 1, pool: "regular",
    });
    receipt("mov_restored");
    expect(sqlite.prepare("SELECT received_quantity, restock_quantity FROM order_return_lines WHERE id = 'line_1'").get())
      .toEqual({ received_quantity: 1, restock_quantity: 1 });
    expect(() => sqlite.exec("DELETE FROM order_return_receipt_lines")).toThrow(/immutable/);
  });
});
