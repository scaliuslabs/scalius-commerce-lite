import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(import.meta.dirname, "../migrations/0013_colorful_the_enforcers.sql"),
  "utf8",
);

describe("item-level return lifecycle migration", () => {
  it("retains return, command, line, receipt, order, and movement evidence", () => {
    expect(migration).toContain("CREATE TABLE `order_returns`");
    expect(migration).toContain("CREATE TABLE `order_return_lines`");
    expect(migration).toContain("CREATE TABLE `order_return_commands`");
    expect(migration).toContain("CREATE TABLE `order_return_receipt_lines`");
    expect(migration).toContain("ON DELETE restrict");
    expect(migration).toContain("return receipt dispositions are immutable");
    expect(migration).toContain("returns are durable order evidence");
  });

  it("enforces cumulative entitlement across concurrent return cases in D1", () => {
    expect(migration).toContain("order_return_lines_validate_insert");
    expect(migration).toContain("order_returns_validate_status_update");
    expect(migration.match(/cumulative return quantity exceeds fulfilled item quantity/g))
      .toHaveLength(2);
    expect(migration).toContain("oi.fulfillment_status IN ('shipped', 'delivered')");
  });

  it("projects immutable receipt dispositions and requires exact movement evidence", () => {
    expect(migration).toContain("order_return_receipt_lines_project_after_insert");
    expect(migration).toContain("received_quantity = received_quantity + NEW.received_quantity");
    expect(migration).toContain("restock_quantity = restock_quantity + NEW.restock_quantity");
    expect(migration).toContain("im.created_by IS NEW.actor_id");
    expect(migration).toContain("return restock disposition lacks matching inventory movement evidence");
  });

  it("keeps remote-D1 guard expressions in WHEN clauses with one-statement bodies", () => {
    expect(migration).not.toContain("SELECT CASE WHEN");

    const triggerBodies = migration
      .split("--> statement-breakpoint")
      .filter((statement) => statement.includes("CREATE TRIGGER"))
      .map((statement) => statement.slice(statement.indexOf("BEGIN") + "BEGIN".length));

    expect(triggerBodies.length).toBeGreaterThan(0);
    for (const body of triggerBodies) {
      expect(body.match(/;/g)).toHaveLength(2);
    }
  });
});
