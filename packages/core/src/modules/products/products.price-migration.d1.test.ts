import { describe, expect, it } from "vitest";
import { compiledMigrationSql, createMigratedSqlite } from "@scalius/database/testing/sqlite-d1";

describe("migration 0077: optioned product price", () => {
  it("brings stored optioned product prices in line once on upgrade", () => {
    const old = createMigratedSqlite({ beforeMigration: "0077_" });
    old.exec(`
      INSERT INTO products (id, name, price_minor, slug) VALUES ('prod_opt', 'Panjabi', 260000, 'panjabi'), ('prod_one', 'Mug', 50000, 'mug');
      INSERT INTO product_variants (id, product_id, option_combination_key, sku, price_minor, is_default, deleted_at) VALUES
        ('v_m', 'prod_opt', 'pval_m', 'P-M', 250000, 0, NULL),
        ('v_l', 'prod_opt', 'pval_l', 'P-L', 240000, 0, NULL),
        ('v_old', 'prod_opt', 'pval_s', 'P-S', 100000, 0, 1),
        ('v_mug', 'prod_one', NULL, 'MUG', 50000, 1, NULL);
    `);
    old.exec(compiledMigrationSql("d1", undefined, "0077_"));
    expect(old.prepare("SELECT id, price_minor FROM products ORDER BY id").all())
      .toEqual([{ id: "prod_one", price_minor: 50_000 }, { id: "prod_opt", price_minor: 240_000 }]);
    old.close();
  });
});
