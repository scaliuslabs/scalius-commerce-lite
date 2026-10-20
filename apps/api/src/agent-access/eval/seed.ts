// The demo store's catalog, customers, orders, reviews and inbox. Seeding
// goes through the real admin routes (an unrecorded full-access MCP session)
// wherever a route exists, so every invariant (ledger, triggers, DVC) holds;
// rows with no admin create route (reviews, inbox threads) are inserted.

import type { EvalStore } from "./store";
import { EVAL_OWNER_ID } from "./store";
import { McpEvalSession, type ToolResult } from "./session";

export interface EvalFixtures {
  categories: { shoes: string; panjabi: string };
  locations: { dhaka: string; chittagong: string };
  products: Record<string, { id: string; variantId: string; sku: string }>;
  customers: { rahim: string; karim: string; salma: string; nadia: string };
  /** The merchant's order numbers in the task prompts, mapped to seeded orders. */
  orders: { o1040: SeededOrder; o1042: SeededOrder; o1043: SeededOrder };
  menus: { main: string; footer: string };
  reviews: { fiveStar: string; fourStar: string; oneStar: string };
  conversation: string;
}

export interface SeededOrder {
  id: string;
  number: string;
}

export class SeedError extends Error {}

function dataOf(result: ToolResult, label: string): Record<string, unknown> {
  const structured = result.structuredContent ?? {};
  if (result.isError || structured.ok !== true) {
    throw new SeedError(`${label}: ${JSON.stringify(structured.error ?? structured).slice(0, 600)}`);
  }
  return (structured.data ?? {}) as Record<string, unknown>;
}

const SIMPLE_PRODUCTS: Array<{ key: string; name: string; price: number; stock: number; category?: "shoes" | "panjabi" }> = [
  { key: "runner", name: "Trail Runner", price: 2000, stock: 30, category: "shoes" },
  { key: "loafer", name: "Leather Loafer", price: 3000, stock: 12, category: "shoes" },
  { key: "sandal", name: "Summer Sandal", price: 1200, stock: 40, category: "shoes" },
  { key: "silk", name: "Silk Panjabi", price: 4500, stock: 2, category: "panjabi" },
  { key: "linen", name: "Linen Shirt", price: 1800, stock: 4 },
  { key: "kurta", name: "Kurta Classic", price: 1500, stock: 50, category: "panjabi" },
  { key: "attar", name: "Eid Attar", price: 900, stock: 1 },
  { key: "belt", name: "Leather Belt", price: 700, stock: 8 },
  { key: "wallet", name: "Bifold Wallet", price: 1100, stock: 15 },
  { key: "cap", name: "Cotton Cap", price: 400, stock: 25 },
];

export async function seedEvalStore(store: EvalStore): Promise<EvalFixtures> {
  const { sqlite } = store;
  const now = Math.floor(Date.now() / 1000);

  // Places and published categories (category create requires an image, see BURST notes).
  sqlite.exec(`
    INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active)
    VALUES ('city_dhaka', 'Dhaka', 'BD', 1, NULL, '{}', '{}', 1), ('zone_gulshan', 'Gulshan', 'BD', 2, 'city_dhaka', '{}', '{}', 1),
           ('city_ctg', 'Chittagong', 'BD', 1, NULL, '{}', '{}', 1), ('zone_agrabad', 'Agrabad', 'BD', 2, 'city_ctg', '{}', '{}', 1);
    INSERT INTO categories (id, name, slug, status) VALUES ('cat_shoes', 'Shoes', 'shoes', 'published'), ('cat_panjabi', 'Panjabi', 'panjabi', 'published');
    UPDATE inventory_locations SET name = 'Dhaka', code = 'DHK', city = 'Dhaka' WHERE id = 'loc_default';
  `);

  store.useGrant("custom");
  const seeder = await McpEvalSession.open({ surface: "dashboard", env: store.env, ctx: store.ctx });
  const write = async (operationId: string, input: Record<string, unknown>) =>
    dataOf(await seeder.call("scalius_write", { operationId, input }), operationId);
  const read = async (operationId: string, input: Record<string, unknown> = {}) =>
    dataOf(await seeder.call("scalius_read", { operationId, input, maxBytes: 65_536 }), operationId);

  try {
    const chittagong = await write("dashboard.inventory_locations.create", {
      body: { name: "Chittagong", code: "CTG", kind: "store", city: "Chittagong", countryCode: "BD" },
    });

    const products: EvalFixtures["products"] = {};
    for (const product of SIMPLE_PRODUCTS) {
      const sku = product.key.toUpperCase();
      const created = await write("dashboard.products.create", {
        body: {
          name: product.name,
          description: null,
          price: product.price,
          categoryId: product.category ? `cat_${product.category}` : null,
          isActive: true,
          freeDelivery: false,
          metaTitle: null,
          metaDescription: null,
          productCondition: "new",
          media: [],
          defaultSku: { sku, trackInventory: true, stock: product.stock },
        },
      });
      const id = String(created.id);
      const variant = sqlite.prepare("SELECT id FROM product_variants WHERE product_id = ? AND deleted_at IS NULL").get(id) as { id: string };
      products[product.key] = { id, variantId: variant.id, sku };
    }

    const customers = {} as EvalFixtures["customers"];
    const people = [
      ["rahim", "Rahim Uddin", "+8801711000001"],
      ["karim", "Karim Ahmed", "+8801711000002"],
      ["salma", "Salma Begum", "+8801711000003"],
      ["nadia", "Nadia Islam", "+8801711000004"],
    ] as const;
    for (const [key, name, phone] of people) {
      const created = await write("dashboard.customers.create", { body: { name, email: null, phone } });
      customers[key] = String(created.id);
    }

    const placeOrder = async (customerId: string, items: Array<{ product: string; quantity: number }>) => {
      const created = await write("dashboard.resources.orders.create", {
        body: {
          customerId,
          items: items.map(({ product, quantity }) => ({ productId: products[product]!.id, variantId: products[product]!.variantId, quantity })),
          shippingMinor: 6000,
          paymentMethod: "cod",
          shippingAddress: { countryCode: "BD", line1: "House 1, Road 2", locality: "Dhaka", placeIds: { city: "city_dhaka", zone: "zone_gulshan" } },
        },
      });
      const order = (created.order ?? created) as { id: string };
      const row = sqlite.prepare("SELECT order_number FROM orders WHERE id = ?").get(order.id) as { order_number: string | null };
      return { id: order.id, number: String(row.order_number ?? order.id) };
    };

    // Karim and Salma are repeat buyers (4 orders); Rahim has 3, Nadia 1.
    for (let index = 0; index < 4; index += 1) await placeOrder(customers.karim, [{ product: "cap", quantity: 1 }]);
    for (let index = 0; index < 4; index += 1) await placeOrder(customers.salma, [{ product: "wallet", quantity: 1 }]);
    await placeOrder(customers.nadia, [{ product: "kurta", quantity: 1 }]);
    const o1040 = await placeOrder(customers.rahim, [{ product: "kurta", quantity: 2 }]);
    const o1042 = await placeOrder(customers.rahim, [{ product: "runner", quantity: 1 }]);
    const o1043 = await placeOrder(customers.rahim, [{ product: "sandal", quantity: 3 }]);

    // #1040 was delivered and paid in cash; #1042 is confirmed and paid (ready to ship).
    sqlite.prepare("UPDATE orders SET status = 'delivered', fulfillment_status = 'complete', payment_status = 'paid', paid_amount_minor = total_amount_minor, balance_due_minor = 0 WHERE id = ?").run(o1040.id);
    sqlite.prepare("UPDATE orders SET status = 'confirmed', payment_status = 'paid', paid_amount_minor = total_amount_minor, balance_due_minor = 0 WHERE id = ?").run(o1042.id);
    for (const order of [o1040, o1042]) {
      sqlite.prepare(`INSERT INTO order_payments (id, order_id, amount_minor, currency, payment_method, payment_type, status, cod_collected_by, created_at, updated_at)
        SELECT ?, id, total_amount_minor, 'BDT', 'cod', 'full', 'succeeded', 'Rider', unixepoch(), unixepoch() FROM orders WHERE id = ?`).run(`pay_cod_${order.id}`, order.id);
    }

    const main = await write("dashboard.navigation.menus_create", { body: { name: "Main menu", handle: "main" } });
    const footer = await write("dashboard.navigation.menus_create", { body: { name: "Footer", handle: "footer" } });
    const menuId = (value: Record<string, unknown>) => String((value.menu as { id: string } | undefined)?.id ?? value.id);

    // Three pending reviews, each on a delivered, fulfilled line (the review trigger's rule).
    const salmaFirst = (sqlite.prepare("SELECT id FROM orders WHERE customer_id = ? ORDER BY created_at, id LIMIT 1").get(customers.salma) as { id: string }).id;
    const karimFirst = (sqlite.prepare("SELECT id FROM orders WHERE customer_id = ? ORDER BY created_at, id LIMIT 1").get(customers.karim) as { id: string }).id;
    for (const orderId of [o1040.id, salmaFirst, karimFirst]) {
      sqlite.prepare("UPDATE orders SET status = 'delivered', fulfillment_status = 'complete' WHERE id = ?").run(orderId);
      // Fulfilled through the ledger: its triggers project fulfilled_quantity.
      sqlite.prepare("UPDATE order_items SET fulfillment_type = 'ship' WHERE order_id = ?").run(orderId);
      sqlite.prepare("INSERT INTO order_fulfillments (id, order_id, kind, status, request_key, actor_type) VALUES (?, ?, 'ship', 'active', 'eval-seed', 'system')")
        .run(`ful_seed_${orderId}`, orderId);
      sqlite.prepare(`INSERT INTO order_fulfillment_lines (id, fulfillment_id, order_id, order_item_id, quantity)
        SELECT 'fl_seed_' || id, ?, order_id, id, quantity - fulfilled_quantity FROM order_items WHERE order_id = ? AND quantity > fulfilled_quantity`)
        .run(`ful_seed_${orderId}`, orderId);
    }
    const review = sqlite.prepare(`INSERT INTO product_reviews (id, product_id, variant_id, order_id, order_item_id, reviewer_key, customer_id,
      author_type, author_display_name, rating, title, body, status, created_at, updated_at)
      SELECT ?, oi.product_id, oi.variant_id, o.id, oi.id, o.customer_id, o.customer_id, 'customer', ?, ?, ?, ?, 'pending', ?, ?
      FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE o.id = ? LIMIT 1`);
    review.run("rev_evalfivestar0001", "Rahim U.", 5, "Perfect fit", "Lovely kurta, fits well.", now - 300, now - 300, o1040.id);
    review.run("rev_evalfourstar0001", "Salma B.", 4, "Good wallet", "Nice leather.", now - 200, now - 200, salmaFirst);
    review.run("rev_evalonestar00001", "Karim A.", 1, "Fell apart", "The stitching came loose in a week.", now - 100, now - 100, karimFirst);

    // Two inbox threads; Nadia's is the newest customer message.
    const thread = sqlite.prepare(`INSERT INTO conversations (id, subject_type, subject_id, customer_id, subject, status, last_seq, last_message_at, last_author_type, created_at, updated_at)
      VALUES (?, 'store', NULL, ?, ?, 'open', 1, ?, 'customer', ?, ?)`);
    const message = sqlite.prepare(`INSERT INTO conversation_messages (id, conversation_id, seq, kind, visibility, author_type, author_customer_id, body, created_at)
      VALUES (?, ?, 1, 'message', 'public', 'customer', ?, ?, ?)`);
    thread.run("cnv_evalolderthread", customers.karim, "Sizes", now - 7_200, now - 7_200, now - 7_200);
    message.run("msg_evalolderthread", "cnv_evalolderthread", customers.karim, "Do you have the cap in blue?", now - 7_200);
    thread.run("cnv_evalnewestthread", customers.nadia, "Delivery time", now - 600, now - 600, now - 600);
    message.run("msg_evalnewestthread", "cnv_evalnewestthread", customers.nadia, "When will my kurta arrive in Dhaka?", now - 600);

    await read("dashboard.home.activity");
    await store.settle();
    void EVAL_OWNER_ID;
    return {
      categories: { shoes: "cat_shoes", panjabi: "cat_panjabi" },
      locations: { dhaka: "loc_default", chittagong: String(chittagong.id) },
      products,
      customers,
      orders: { o1040, o1042, o1043 },
      menus: { main: menuId(main), footer: menuId(footer) },
      reviews: { fiveStar: "rev_evalfivestar0001", fourStar: "rev_evalfourstar0001", oneStar: "rev_evalonestar00001" },
      conversation: "cnv_evalnewestthread",
    };
  } finally {
    await seeder.close();
  }
}
