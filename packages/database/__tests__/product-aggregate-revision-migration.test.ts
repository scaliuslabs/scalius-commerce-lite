import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const schemaSource = readFileSync(
  fileURLToPath(new URL("../src/schema/products.ts", import.meta.url)),
  "utf8",
);
const migrationSource = readFileSync(
  fileURLToPath(new URL("../migrations/0005_deep_morg.sql", import.meta.url)),
  "utf8",
);

describe("product aggregate revision migration", () => {
  it("starts every existing and new aggregate at revision one", () => {
    expect(schemaSource).toContain(
      'aggregateRevision: integer("aggregate_revision").notNull().default(1)',
    );
    expect(migrationSource.trim()).toBe(
      "ALTER TABLE `products` ADD `aggregate_revision` integer DEFAULT 1 NOT NULL;",
    );
  });
});
