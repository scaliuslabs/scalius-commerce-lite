import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(import.meta.dirname, "../migrations/0012_light_bedlam.sql"),
  "utf8",
);

describe("inventory operation idempotency migration", () => {
  it("uses the merchant operation key as the unique durable replay identity", () => {
    expect(migration).toContain(
      "`operation_key` text PRIMARY KEY NOT NULL",
    );
    expect(migration).toContain("`request_hash` text NOT NULL");
    expect(migration).toContain("`result_payload` text NOT NULL");
  });

  it("links committed operations to the SKU, movement, and stockVersion edge", () => {
    expect(migration).toContain(
      "FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`)",
    );
    expect(migration).toContain(
      "FOREIGN KEY (`movement_id`) REFERENCES `inventory_movements`(`id`)",
    );
    expect(migration).toContain("`stock_version_before` integer NOT NULL");
    expect(migration).toContain("`stock_version_after` integer NOT NULL");
  });
});
