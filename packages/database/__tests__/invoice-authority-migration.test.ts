import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(import.meta.dirname, "../migrations/0014_green_nightcrawler.sql"),
  "utf8",
);

describe("invoice authority migration", () => {
  it("creates one immutable invoice per order with a monotonic sequence", () => {
    expect(migration).toContain("CREATE TABLE `invoice_sequences`");
    expect(migration).toContain("VALUES ('default', 0, unixepoch())");
    expect(migration).toContain("CREATE TABLE `order_invoices`");
    expect(migration).toContain("order_invoices_order_unique");
    expect(migration).toContain("order_invoices_number_unique");
    expect(migration).toContain("ON DELETE restrict");
    expect(migration).toContain("order_invoices_immutable_update");
    expect(migration).toContain("order_invoices_immutable_delete");
  });

  it("persists globally idempotent immutable issuance evidence", () => {
    expect(migration).toContain("CREATE TABLE `invoice_issue_commands`");
    expect(migration).toContain("invoice_issue_commands_operation_key_unique");
    expect(migration).toContain("invoice_issue_commands_immutable_update");
    expect(migration).toContain("invoice_issue_commands_immutable_delete");
  });

  it("clears legacy lazy numbers that have no reproducible snapshot", () => {
    expect(migration).toContain(
      "UPDATE `orders` SET `invoice_number` = NULL WHERE `invoice_number` IS NOT NULL",
    );
  });
});
