import { DatabaseSync } from "node:sqlite";

import type { Database } from "@scalius/database/client";
import { DiscountType, DiscountValueType } from "@scalius/database/schema";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { afterEach, describe, expect, it, vi } from "vitest";

import { calculateDiscountAmount, isDiscountValid } from "./discounts.eligibility";

const NOW_SECONDS = 1_800_000_000;
const PHONE = "+8801712345678";

describe("discount checkout enforcement", () => {
  let sqlite: DatabaseSync | null = null;

  afterEach(() => {
    vi.useRealTimers();
    sqlite?.close();
    sqlite = null;
  });

  function createDatabase(): Database {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE discounts (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        value_type TEXT NOT NULL,
        discount_value REAL NOT NULL,
        min_purchase_amount REAL,
        min_quantity INTEGER,
        max_uses_per_order INTEGER,
        max_uses INTEGER,
        limit_one_per_customer INTEGER NOT NULL DEFAULT 0,
        combine_with_product_discounts INTEGER NOT NULL DEFAULT 0,
        combine_with_order_discounts INTEGER NOT NULL DEFAULT 0,
        combine_with_shipping_discounts INTEGER NOT NULL DEFAULT 0,
        customer_segment TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        start_date INTEGER NOT NULL,
        end_date INTEGER,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      );
      CREATE TABLE discount_products (
        id TEXT PRIMARY KEY,
        discount_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        application_type TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE discount_collections (
        id TEXT PRIMARY KEY,
        discount_id TEXT NOT NULL,
        collection_id TEXT NOT NULL,
        application_type TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE discount_usage (
        id TEXT PRIMARY KEY,
        discount_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        customer_id TEXT,
        amount_discounted REAL NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE discount_customer_redemptions (
        discount_id TEXT NOT NULL,
        customer_key TEXT NOT NULL,
        order_id TEXT NOT NULL,
        customer_id TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (discount_id, customer_key)
      );
      CREATE TABLE products (
        id TEXT PRIMARY KEY,
        category_id TEXT,
        is_active INTEGER NOT NULL,
        deleted_at INTEGER
      );
      CREATE TABLE collections (
        id TEXT PRIMARY KEY,
        config TEXT NOT NULL,
        is_active INTEGER NOT NULL,
        deleted_at INTEGER
      );
    `);

    return drizzle(async (query, params, method) => {
      const statement = sqlite!.prepare(query);
      statement.setReturnArrays(true);
      if (method === "run") {
        statement.run(...params);
        return { rows: [] };
      }
      if (method === "get") {
        return { rows: statement.get(...params) as unknown as unknown[] };
      }
      return { rows: statement.all(...params) as unknown as unknown[][] };
    }) as unknown as Database;
  }

  function seedDiscount({
    id,
    code,
    type = DiscountType.AMOUNT_OFF_ORDER,
    valueType = DiscountValueType.PERCENTAGE,
    discountValue = 10,
    minPurchaseAmount = null,
    minQuantity = null,
    maxUses = null,
    limitOnePerCustomer = false,
    startDate = NOW_SECONDS - 60,
    endDate = NOW_SECONDS + 60,
  }: {
    id: string;
    code: string;
    type?: DiscountType;
    valueType?: DiscountValueType;
    discountValue?: number;
    minPurchaseAmount?: number | null;
    minQuantity?: number | null;
    maxUses?: number | null;
    limitOnePerCustomer?: boolean;
    startDate?: number;
    endDate?: number | null;
  }) {
    sqlite!.prepare(`
      INSERT INTO discounts (
        id, code, type, value_type, discount_value, min_purchase_amount,
        min_quantity, max_uses_per_order, max_uses, limit_one_per_customer,
        start_date, end_date, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      id,
      code,
      type,
      valueType,
      discountValue,
      minPurchaseAmount,
      minQuantity,
      maxUses,
      limitOnePerCustomer ? 1 : 0,
      startDate,
      endDate,
      NOW_SECONDS,
      NOW_SECONDS,
    );
  }

  it("enforces start and inclusive end timestamps from the authoritative row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_SECONDS * 1_000));
    const db = createDatabase();
    seedDiscount({ id: "disc_ends_now", code: "ENDS_NOW", endDate: NOW_SECONDS });
    seedDiscount({
      id: "disc_scheduled",
      code: "SCHEDULED",
      startDate: NOW_SECONDS + 1,
      endDate: NOW_SECONDS + 60,
    });

    await expect(isDiscountValid(db, "ENDS_NOW", 500, [])).resolves.toMatchObject({
      valid: true,
    });
    await expect(isDiscountValid(db, "SCHEDULED", 500, [])).resolves.toEqual({
      valid: false,
      error: "Invalid discount code",
    });

    vi.setSystemTime(new Date((NOW_SECONDS + 1) * 1_000));
    await expect(isDiscountValid(db, "ENDS_NOW", 500, [])).resolves.toEqual({
      valid: false,
      error: "Invalid discount code",
    });
  });

  it("requires every configured purchase minimum", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_SECONDS * 1_000));
    const db = createDatabase();
    seedDiscount({
      id: "disc_minimums",
      code: "MINIMUMS",
      minPurchaseAmount: 500,
      minQuantity: 2,
    });

    await expect(
      isDiscountValid(db, "MINIMUMS", 499, [{ id: "prod_1", price: 499, quantity: 2 }]),
    ).resolves.toMatchObject({ valid: false, minPurchaseAmount: 500 });
    await expect(
      isDiscountValid(db, "MINIMUMS", 500, [{ id: "prod_1", price: 500, quantity: 1 }]),
    ).resolves.toMatchObject({ valid: false, minQuantity: 2 });
  });

  it("enforces total and canonical phone redemption limits", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_SECONDS * 1_000));
    const db = createDatabase();
    seedDiscount({ id: "disc_total", code: "TOTAL_LIMIT", maxUses: 1 });
    seedDiscount({
      id: "disc_customer",
      code: "PHONE_LIMIT",
      limitOnePerCustomer: true,
    });
    sqlite!.prepare(`
      INSERT INTO discount_usage
        (id, discount_id, order_id, amount_discounted, created_at)
      VALUES ('usage_1', 'disc_total', 'order_1', 10, ?)
    `).run(NOW_SECONDS);
    sqlite!.prepare(`
      INSERT INTO discount_customer_redemptions
        (discount_id, customer_key, order_id, created_at)
      VALUES ('disc_customer', ?, 'order_1', ?)
    `).run(`phone:${PHONE}`, NOW_SECONDS);

    await expect(isDiscountValid(db, "TOTAL_LIMIT", 500, [])).resolves.toMatchObject({
      valid: false,
      error: "Discount code has reached its usage limit",
    });
    await expect(
      isDiscountValid(db, "PHONE_LIMIT", 500, [], ` ${PHONE} `),
    ).resolves.toMatchObject({
      valid: false,
      error: "This discount code can only be used once per customer",
    });
  });

  it("enforces a stable account redemption when the delivery phone changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_SECONDS * 1_000));
    const db = createDatabase();
    seedDiscount({
      id: "disc_customer",
      code: "ACCOUNT_LIMIT",
      limitOnePerCustomer: true,
    });
    sqlite!.prepare(`
      INSERT INTO discount_customer_redemptions
        (discount_id, customer_key, order_id, customer_id, created_at)
      VALUES ('disc_customer', 'customer:cust_account', 'order_1', 'cust_account', ?)
    `).run(NOW_SECONDS);

    await expect(
      isDiscountValid(
        db,
        "ACCOUNT_LIMIT",
        500,
        [],
        "+8801912345678",
        "",
        "BDT",
        "cust_account",
      ),
    ).resolves.toMatchObject({
      valid: false,
      error: "This discount code can only be used once per customer",
    });
  });

  it("keeps exact product scope through calculation without subtotal fallback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_SECONDS * 1_000));
    const db = createDatabase();
    seedDiscount({
      id: "disc_product",
      code: "PRODUCT50",
      type: DiscountType.AMOUNT_OFF_PRODUCTS,
      valueType: DiscountValueType.FIXED_AMOUNT,
      discountValue: 50,
    });
    sqlite!.prepare(`
      INSERT INTO products (id, is_active, deleted_at)
      VALUES ('prod_eligible', 1, NULL), ('prod_other', 1, NULL)
    `).run();
    sqlite!.prepare(`
      INSERT INTO discount_products
        (id, discount_id, product_id, application_type, created_at)
      VALUES ('dp_1', 'disc_product', 'prod_eligible', 'get', ?)
    `).run(NOW_SECONDS);

    await expect(
      isDiscountValid(db, "PRODUCT50", 100, [{ id: "prod_other", price: 100, quantity: 1 }]),
    ).resolves.toMatchObject({
      valid: false,
      error: "Discount code is not applicable to the items in your cart",
    });

    const validation = await isDiscountValid(
      db,
      "PRODUCT50",
      100,
      [{ id: "prod_eligible", price: 100, quantity: 1 }],
    );
    expect(validation).toMatchObject({ valid: true, hasProductRestrictions: true });
    await expect(calculateDiscountAmount(
      db,
      validation.discount!,
      160,
      [{ id: "prod_eligible", price: 100, quantity: 1 }],
      60,
      validation.applicableProductIds,
    )).resolves.toBe(50);
  });
});
