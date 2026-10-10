// Test-only generator for the scale run: a store with a year of orders
// (lines, COD tracking, parcels, returns, payments and refunds) bulk-loaded
// into a migrated node:sqlite database with its triggers dropped.
import { analyticsRollupBackfillStatements } from "@scalius/database/analytics-rollup";
import type { SqliteTestDatabase } from "@scalius/database/testing/sqlite-d1";

const DAY = 86_400;

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, entries: ReadonlyArray<readonly [T, number]>): T {
  let roll = rand();
  for (const [value, weight] of entries) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return entries[entries.length - 1]![0];
}

/** Loads `orderCount` orders spread over the 365 days before `now`. */
export function seedScaleStore(db: SqliteTestDatabase, orderCount: number, now: Date) {
  const { sqlite } = db;
  const rand = random(42);
  // Bulk-load source rows, then rebuild the same projections the migration installs.
  const triggers = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>;
  for (const { name } of triggers) sqlite.exec(`DROP TRIGGER "${name}"`);
  const products = Math.max(200, Math.round(orderCount / 20));
  const customers = Math.max(100, Math.round(orderCount / 3));
  const start = Math.floor(now.getTime() / 1000) - 365 * DAY;
  sqlite.exec("BEGIN");
  const category = sqlite.prepare("INSERT INTO categories (id, name, slug, status) VALUES (?, ?, ?, 'published')");
  for (let index = 0; index < 30; index += 1) category.run(`cat_${index}`, `Category ${index}`, `category-${index}`);
  const brand = sqlite.prepare("INSERT INTO brands (id, name, slug, status) VALUES (?, ?, ?, 'published')");
  for (let index = 0; index < 20; index += 1) brand.run(`brd_brand${index}`, `Brand ${index}`, `brand-${index}`);
  const product = sqlite.prepare("INSERT INTO products (id, name, slug, price_minor, category_id, brand_id, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)");
  const variant = sqlite.prepare("INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory, low_stock_threshold) VALUES (?, ?, ?, ?, ?, 1, 1, ?)");
  const level = sqlite.prepare("INSERT INTO inventory_levels (variant_id, location_id, on_hand) VALUES (?, 'loc_default', ?)");
  const prices: number[] = [];
  for (let index = 0; index < products; index += 1) {
    const price = (5 + Math.floor(rand() * 300)) * 100;
    prices.push(price);
    const stock = Math.floor(rand() * 60);
    product.run(`prod_${index}`, `Product ${index}`, `product-${index}`, price, `cat_${index % 30}`, index % 3 === 0 ? null : `brd_brand${index % 20}`);
    variant.run(`var_${index}`, `prod_${index}`, `SKU-${index}`, price, stock, index % 7 === 0 ? 10 : null);
    level.run(`var_${index}`, stock);
  }
  const customer = sqlite.prepare("INSERT INTO customers (id, name, phone, created_at) VALUES (?, ?, ?, ?)");
  for (let index = 0; index < customers; index += 1) {
    customer.run(`cus_${index}`, `Customer ${index}`, `+88017${String(index).padStart(8, "0")}`, start);
  }
  const order = sqlite.prepare(`
    INSERT INTO orders (id, customer_name, customer_phone, customer_id, shipping_address, city, zone, city_name,
      currency_code, subtotal_amount_minor, shipping_amount_minor, discount_amount_minor, tax_amount_minor,
      total_amount_minor, status, payment_method, payment_status, paid_amount_minor, balance_due_minor,
      fulfillment_status, channel, channel_source, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'Road 1', 'city', 'zone', ?, 'BDT', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const item = sqlite.prepare(`
    INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, product_name, unit_price_minor,
      line_subtotal_minor, discount_amount_minor, fulfillment_type, fulfilled_quantity, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ship', ?, ?)
  `);
  const cod = sqlite.prepare("INSERT INTO cod_tracking (id, order_id, cod_status, collected_amount_minor, collected_at) VALUES (?, ?, ?, ?, ?)");
  const shipment = sqlite.prepare("INSERT INTO delivery_shipments (id, order_id, provider_type, courier_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const payment = sqlite.prepare("INSERT INTO order_payments (id, order_id, amount_minor, currency, payment_method, payment_type, status, created_at, updated_at) VALUES (?, ?, ?, 'BDT', ?, ?, ?, ?, ?)");
  const returnCase = sqlite.prepare("INSERT INTO order_returns (id, order_id, status, reason, actor_type, source) VALUES (?, ?, 'completed', 'Size', 'admin', 'admin')");
  const returnLine = sqlite.prepare("INSERT INTO order_return_lines (id, return_id, order_id, order_item_id, variant_id, inventory_tracked, requested_quantity, approved_quantity) VALUES (?, ?, ?, ?, ?, 0, 1, 1)");
  const cities = ["Dhaka", "Chattogram", "Sylhet", "Khulna", "Rajshahi", "Barishal", "Rangpur", "Mymensingh", "Cumilla", "Gazipur"];
  for (let index = 0; index < orderCount; index += 1) {
    const id = `ord_${index}`;
    const createdAt = start + Math.floor(rand() * 365 * DAY);
    const method = pick(rand, [["cod", 0.75], ["sslcommerz", 0.2], ["stripe", 0.05]] as const);
    const status = pick(rand, method === "cod"
      ? [["delivered", 0.55], ["returned", 0.12], ["shipped", 0.1], ["pending", 0.08], ["cancelled", 0.12], ["confirmed", 0.03]] as const
      : [["delivered", 0.7], ["incomplete", 0.1], ["refunded", 0.05], ["shipped", 0.1], ["cancelled", 0.05]] as const);
    const lines = 1 + Math.floor(rand() * 3);
    let subtotal = 0;
    let discount = 0;
    const lineIds: Array<{ id: string; variant: string; product: number; quantity: number; gross: number; discount: number }> = [];
    for (let line = 0; line < lines; line += 1) {
      const productIndex = Math.floor(rand() ** 2 * products);
      const quantity = 1 + Math.floor(rand() * 2);
      const gross = prices[productIndex]! * quantity;
      const lineDiscount = rand() < 0.2 ? Math.floor(gross / 10 / 100) * 100 : 0;
      subtotal += gross;
      discount += lineDiscount;
      lineIds.push({ id: `${id}_${line}`, variant: `var_${productIndex}`, product: productIndex, quantity, gross, discount: lineDiscount });
    }
    const shipping = 6_000;
    const total = subtotal + shipping - discount;
    const paid = method !== "cod" && status !== "incomplete" ? total : status === "delivered" ? total : 0;
    const customerIndex = Math.floor(rand() ** 1.5 * customers);
    order.run(
      id, `Customer ${customerIndex}`, `+88017${String(customerIndex).padStart(8, "0")}`, `cus_${customerIndex}`,
      cities[index % cities.length]!, subtotal, shipping, discount, total, status, method,
      paid >= total ? "paid" : "unpaid", paid, total - paid,
      ["shipped", "delivered", "returned", "refunded"].includes(status) ? "complete" : "pending",
      index % 7 === 0 ? "admin" : "online_store", index % 7 === 0 ? "facebook" : null, createdAt, createdAt,
    );
    for (const line of lineIds) {
      item.run(line.id, id, `prod_${line.product}`, line.variant, line.quantity, `Product ${line.product}`,
        prices[line.product]!, line.gross, line.discount, line.quantity, createdAt);
    }
    if (method === "cod") {
      cod.run(`cod_${id}`, id, status === "delivered" ? "collected" : status === "returned" ? "returned" : "pending",
        status === "delivered" ? total : null, status === "delivered" ? createdAt + 3 * DAY : null);
    } else if (status !== "incomplete") {
      payment.run(`pay_${id}`, id, total, method, "full", "confirmed", createdAt, createdAt);
    }
    if (["shipped", "delivered", "returned", "refunded"].includes(status)) {
      const courier = index % 2 === 0 ? "Pathao" : "Steadfast";
      shipment.run(`shp_${id}`, id, courier.toLowerCase(), courier,
        status === "shipped" ? "in_transit" : status === "returned" ? "returned" : "delivered", createdAt + DAY, createdAt + DAY);
    }
    if (status === "refunded") payment.run(`ref_${id}`, id, total, method, "refund", "refunded", createdAt + 5 * DAY, createdAt + 5 * DAY);
    if (status === "delivered" && rand() < 0.05) {
      returnCase.run(`ret_${id}`, id);
      returnLine.run(`retl_${id}`, `ret_${id}`, id, lineIds[0]!.id, lineIds[0]!.variant);
    }
  }
  for (const statement of analyticsRollupBackfillStatements()) sqlite.exec(statement);
  sqlite.exec("COMMIT");
  sqlite.exec("ANALYZE");
}
