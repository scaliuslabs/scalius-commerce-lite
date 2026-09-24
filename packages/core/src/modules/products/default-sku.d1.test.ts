import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@scalius/database/client";
import * as schema from "@scalius/database/schema";
import { createProduct } from "./admin/write";
import { saveProductOptionMatrix } from "./option-matrix";
import { updateVariant } from "./variants";
import { createProductSchema } from "./validation";

vi.mock("../inventory/alerts", () => ({ checkAndAlertLowStock: vi.fn() }));

interface D1Statement {
  bind(...values: SQLInputValue[]): D1Statement;
  run(): Promise<unknown>;
  all(): Promise<unknown>;
  raw(): Promise<SQLOutputValue[][]>;
  first(column?: string): Promise<unknown>;
  execute(): { results: Record<string, SQLOutputValue>[]; success: true; meta: Record<string, never> };
}

function d1Statement(sqlite: DatabaseSync, query: string, values: SQLInputValue[] = []): D1Statement {
  const execute = () => ({ results: sqlite.prepare(query).all(...values), success: true as const, meta: {} });
  return {
    bind: (...next) => d1Statement(sqlite, query, next),
    run: async () => execute(),
    all: async () => execute(),
    raw: async () => {
      const statement = sqlite.prepare(query);
      statement.setReturnArrays(true);
      return statement.all(...values) as unknown as SQLOutputValue[][];
    },
    first: async (column) => {
      const row = sqlite.prepare(query).all(...values)[0];
      return column ? row?.[column] ?? null : row ?? null;
    },
    execute,
  };
}

const productInput = {
  name: "Simple mug",
  description: null,
  price: 250,
  categoryId: "cat_1",
  isActive: true,
  discountType: "percentage" as const,
  discountPercentage: 0,
  discountAmount: 0,
  freeDelivery: false,
  metaTitle: null,
  metaDescription: null,
  canonicalPath: null,
  noIndex: false,
  excludeFromSitemap: false,
  excludeFromProductFeed: false,
  productCondition: "new" as const,
  slug: "simple-mug",
  media: [],
  attributes: [],
  additionalInfo: [],
};

describe("simple product default SKU inventory on D1 storage", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    const migrations = new URL("../../../../database/migrations/", import.meta.url);
    for (const name of readdirSync(migrations).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort()) {
      sqlite.exec(readFileSync(new URL(name, migrations), "utf8"));
    }
    sqlite.exec("INSERT INTO categories (id, name, slug) VALUES ('cat_1', 'Mugs', 'mugs');");
    const binding = {
      prepare: (query: string) => d1Statement(sqlite, query),
      async batch(statements: D1Statement[]) {
        sqlite.exec("BEGIN");
        try {
          const results = statements.map((statement) => statement.execute());
          sqlite.exec("COMMIT");
          return results;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      },
    };
    db = drizzle(binding as unknown as D1Database, { schema }) as unknown as Database;
  });

  afterEach(() => sqlite.close());

  function defaultSku(productId: string) {
    return sqlite.prepare(
      "SELECT sku, stock, stock_version, track_inventory FROM product_variants WHERE id = ?",
    ).get(`var_default_${productId}`);
  }

  function movementQuantities(productId: string) {
    return sqlite.prepare(
      "SELECT quantity FROM inventory_movements WHERE variant_id = ? ORDER BY created_at, id",
    ).all(`var_default_${productId}`).map((row) => row.quantity);
  }

  it("creates a tracked simple SKU with its opening stock recorded in the ledger", async () => {
    const input = createProductSchema.parse({
      ...productInput,
      defaultSku: { sku: "MUG-WHITE", trackInventory: true, stock: 7 },
    });
    const { id } = await createProduct(db, input);

    expect(defaultSku(id)).toEqual({ sku: "MUG-WHITE", stock: 7, stock_version: 2, track_inventory: 1 });
    expect(movementQuantities(id)).toEqual([7]);
  });

  it("generates a readable untracked SKU from the title when no inventory is sent", async () => {
    const { id } = await createProduct(db, createProductSchema.parse(productInput));

    expect(defaultSku(id)).toEqual({ sku: "SIMPLE-MUG", stock: 0, stock_version: 1, track_inventory: 0 });
    expect(movementQuantities(id)).toEqual([]);
  });

  it("refuses a taka price or flat discount with paisa and creates nothing", async () => {
    await expect(createProduct(db, createProductSchema.parse({ ...productInput, price: 249.5 })))
      .rejects.toMatchObject({ status: 400, message: "Taka amounts are whole numbers." });
    await expect(createProduct(db, createProductSchema.parse({
      ...productInput,
      discountType: "flat",
      discountAmount: 10.25,
    }))).rejects.toMatchObject({ status: 400, message: "Taka amounts are whole numbers." });
    expect(sqlite.prepare("SELECT count(*) AS n FROM products").get()).toEqual({ n: 0 });
  });

  it("rejects a quantity without tracking and inventory beside an option matrix", () => {
    expect(createProductSchema.safeParse({
      ...productInput,
      defaultSku: { trackInventory: false, stock: 3 },
    }).success).toBe(false);
    expect(createProductSchema.safeParse({
      ...productInput,
      defaultSku: { trackInventory: true, stock: 0 },
      optionMatrix: {
        options: [{ id: "o", name: "Size", standardMapping: "size", values: [{ id: "v", value: "S" }] }],
        variants: [{
          id: "s", selectedOptionValueIds: ["v"], imageId: null, sku: "MUG-S", price: 250, stock: 0,
          trackInventory: true, weight: null, barcode: null, barcodeType: null,
          discountType: "percentage", discountPercentage: null, discountAmount: null,
        }],
      },
    }).success).toBe(false);
  });

  it("edits the simple SKU without touching stock unless a quantity is sent", async () => {
    const { id } = await createProduct(db, createProductSchema.parse({
      ...productInput,
      defaultSku: { trackInventory: true, stock: 5 },
    }));
    // A checkout-style decrement lands after the editor loaded quantity 5.
    sqlite.prepare("UPDATE product_variants SET stock = 4, stock_version = stock_version + 1 WHERE id = ?")
      .run(`var_default_${id}`);

    const edit = {
      selectedOptionValueIds: [],
      imageId: null,
      weight: null,
      sku: "MUG-RENAMED",
      price: 250,
      trackInventory: true,
    };
    const renamed = await updateVariant(db, id, `var_default_${id}`, { ...edit, expectedAggregateRevision: 1 });
    expect(defaultSku(id)).toMatchObject({ sku: "MUG-RENAMED", stock: 4 });

    // A quantity typed against the stockVersion loaded before the sale fails closed.
    await expect(updateVariant(db, id, `var_default_${id}`, {
      ...edit,
      stock: 9,
      expectedStockVersion: 2,
      expectedAggregateRevision: renamed.aggregateRevision,
    })).rejects.toThrow("Stock changed since you opened this product. Reload to see the latest.");
    expect(defaultSku(id)).toMatchObject({ stock: 4, stock_version: 3 });

    await updateVariant(db, id, `var_default_${id}`, {
      ...edit,
      stock: 9,
      expectedStockVersion: 3,
      expectedAggregateRevision: renamed.aggregateRevision,
    });
    expect(defaultSku(id)).toMatchObject({ stock: 9 });
    expect(movementQuantities(id)).toEqual([5, 5]);
  });
});

describe("option matrix quantity edits on D1 storage", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    const migrations = new URL("../../../../database/migrations/", import.meta.url);
    for (const name of readdirSync(migrations).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort()) {
      sqlite.exec(readFileSync(new URL(name, migrations), "utf8"));
    }
    sqlite.exec("INSERT INTO categories (id, name, slug) VALUES ('cat_1', 'Mugs', 'mugs');");
    const binding = {
      prepare: (query: string) => d1Statement(sqlite, query),
      async batch(statements: D1Statement[]) {
        sqlite.exec("BEGIN");
        try {
          const results = statements.map((statement) => statement.execute());
          sqlite.exec("COMMIT");
          return results;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      },
    };
    db = drizzle(binding as unknown as D1Database, { schema }) as unknown as Database;
  });

  afterEach(() => sqlite.close());

  async function createSizedMug() {
    const { id } = await createProduct(db, createProductSchema.parse({
      ...productInput,
      optionMatrix: {
        options: [{
          id: "draft_size", name: "Size", standardMapping: "size",
          values: [{ id: "draft_s", value: "S" }, { id: "draft_m", value: "M" }],
        }],
        variants: ["s", "m"].map((size) => ({
          id: `draft_${size}_row`, selectedOptionValueIds: [`draft_${size}`], imageId: null,
          sku: `MUG-${size.toUpperCase()}`, price: 250, stock: 5, trackInventory: true, weight: null,
          barcode: null, barcodeType: null, discountType: "percentage",
          discountPercentage: null, discountAmount: null,
        })),
      },
    }));
    return id;
  }

  /** What the dashboard editor holds after opening the product. */
  function openEditor(productId: string) {
    const option = sqlite.prepare(
      "SELECT id, name FROM product_option_definitions WHERE product_id = ? AND deleted_at IS NULL",
    ).get(productId)!;
    const values = sqlite.prepare(
      "SELECT id, value FROM product_option_values WHERE option_definition_id = ? ORDER BY position",
    ).all(option.id as string);
    const rows = sqlite.prepare(`
      SELECT v.id, v.sku, v.stock, v.stock_version, a.option_value_id
      FROM product_variants v JOIN product_variant_option_values a ON a.variant_id = v.id
      WHERE v.product_id = ? AND v.deleted_at IS NULL ORDER BY v.sku
    `).all(productId);
    return {
      options: [{
        id: option.id as string, name: "Size", standardMapping: "size" as const,
        values: values.map((value) => ({ id: value.id as string, value: value.value as string })),
      }],
      rows: rows.map((row) => ({
        id: row.id as string,
        sku: row.sku as string,
        stock: row.stock as number,
        stockVersion: row.stock_version as number,
        selectedOptionValueIds: [row.option_value_id as string],
      })),
    };
  }

  function variantRow(row: ReturnType<typeof openEditor>["rows"][number], price: number) {
    return {
      id: row.id, selectedOptionValueIds: row.selectedOptionValueIds, imageId: null, sku: row.sku,
      price, trackInventory: true, weight: null, barcode: null, barcodeType: null,
      discountType: "percentage" as const, discountPercentage: null, discountAmount: null,
    };
  }

  function skuState(sku: string) {
    return sqlite.prepare("SELECT stock, price_minor / 100.0 AS price FROM product_variants WHERE sku = ?").get(sku);
  }

  it("keeps a concurrent sale when saving an unrelated change and rejects a stale quantity", async () => {
    const id = await createSizedMug();
    const editor = openEditor(id);
    // A sale lands on size S after the editor opened.
    sqlite.prepare("UPDATE product_variants SET stock = stock - 1, stock_version = stock_version + 1 WHERE sku = 'MUG-S'").run();

    // Price-only save: no quantity is sent for unchanged rows.
    const priced = await saveProductOptionMatrix(db, id, {
      options: editor.options,
      variants: editor.rows.map((row) => variantRow(row, 300)),
      expectedAggregateRevision: 1,
    });
    expect(skuState("MUG-S")).toEqual({ stock: 4, price: 300 });
    expect(skuState("MUG-M")).toEqual({ stock: 5, price: 300 });

    // A quantity typed against the pre-sale stockVersion fails and writes nothing.
    const small = editor.rows.find((row) => row.sku === "MUG-S")!;
    const medium = editor.rows.find((row) => row.sku === "MUG-M")!;
    await expect(saveProductOptionMatrix(db, id, {
      options: editor.options,
      variants: [
        { ...variantRow(small, 350), stock: 9, expectedStockVersion: small.stockVersion },
        variantRow(medium, 350),
      ],
      expectedAggregateRevision: priced.aggregateRevision,
    })).rejects.toThrow("Stock changed since you opened this product. Reload to see the latest.");
    expect(skuState("MUG-S")).toEqual({ stock: 4, price: 300 });

    // After reloading, the same edit applies through the ledger.
    const reloaded = openEditor(id);
    const reloadedSmall = reloaded.rows.find((row) => row.sku === "MUG-S")!;
    await saveProductOptionMatrix(db, id, {
      options: reloaded.options,
      variants: [
        { ...variantRow(reloadedSmall, 350), stock: 9, expectedStockVersion: reloadedSmall.stockVersion },
        variantRow(reloaded.rows.find((row) => row.sku === "MUG-M")!, 350),
      ],
      expectedAggregateRevision: priced.aggregateRevision,
    });
    expect(skuState("MUG-S")).toEqual({ stock: 9, price: 350 });
    expect(sqlite.prepare(
      "SELECT quantity FROM inventory_movements m JOIN product_variants v ON v.id = m.variant_id WHERE v.sku = 'MUG-S' ORDER BY m.created_at, m.id",
    ).all().map((row) => row.quantity)).toEqual([5, 5]);
  });
});
