/**
 * The seeded store of the Workers Free plan budget (free-plan-budget.test.ts
 * in Node, free-plan-workerd.test.ts in workerd): a published category, 3 SKUs
 * (one optioned product), 100 single-SKU products for the 20- and 99-line
 * carts, shipping and delivery locations, email and customer sign-in settings,
 * 1,000 orders for the order list.
 */
import type { DatabaseSync } from "node:sqlite";

export const CATALOG_LINES = 100;

export function seedCatalog(sqlite: DatabaseSync): void {
  sqlite.exec(`
    INSERT INTO categories (id, name, slug, status) VALUES ('cat_panjabi', 'Panjabi', 'panjabi', 'published');
    INSERT INTO delivery_locations (id, name, type, parent_id, external_ids, metadata, is_active)
      VALUES ('city_1', 'Dhaka', 'city', NULL, '{}', '{}', 1), ('zone_1', 'Gulshan', 'zone', 'city_1', '{}', '{}', 1);
    INSERT INTO delivery_zones (id, name) VALUES ('dz_bd', 'Bangladesh'); INSERT INTO delivery_zone_regions (country_code, zone_id) VALUES ('BD', 'dz_bd'); INSERT INTO shipping_methods (id, name, fee_minor, kind, zone_id) VALUES ('m_std', 'Standard', 6000, 'delivery', 'dz_bd');
    INSERT INTO products (id, name, price_minor, slug, category_id, is_active) VALUES
      ('p_linen', 'Linen Panjabi', 250000, 'linen-panjabi', 'cat_panjabi', 1),
      ('p_cotton', 'Cotton Panjabi', 180000, 'cotton-panjabi', 'cat_panjabi', 1);
    INSERT INTO product_option_definitions (id, product_id, name, normalized_name, position) VALUES ('opt_size', 'p_linen', 'Size', 'size', 0);
    INSERT INTO product_option_values (id, option_definition_id, value, normalized_value, position) VALUES
      ('ov_m', 'opt_size', 'M', 'm', 0), ('ov_l', 'opt_size', 'L', 'l', 1);
    INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory, option_combination_key) VALUES
      ('v_linen_m', 'p_linen', 'LIN-M', 250000, 500, 0, 0, 1, 'M'),
      ('v_linen_l', 'p_linen', 'LIN-L', 250000, 500, 0, 0, 1, 'L'),
      ('v_cotton', 'p_cotton', 'COT-1', 180000, 500, 0, 1, 1, NULL);
    INSERT INTO product_variant_option_values (variant_id, option_definition_id, option_value_id) VALUES
      ('v_linen_m', 'opt_size', 'ov_m'), ('v_linen_l', 'opt_size', 'ov_l');
    INSERT INTO media (id, filename, kind, object_key, size, mime_type, status, width, height, variant_width) VALUES
      ('media_linen', 'linen.jpg', 'image', 'media/linen.jpg', 1, 'image/jpeg', 'ready', 1600, 1600, 1600);
    INSERT INTO product_media (id, product_id, media_id, is_primary, sort_order) VALUES ('pmed_linen', 'p_linen', 'media_linen', 1, 0);
    INSERT INTO settings (id, key, value, type, category)
      VALUES ('email', 'document', '{"provider":"cloudflare","sender":"shop@shop.test","resendApiKey":""}', 'json', 'email');
    INSERT INTO settings (id, key, value, type, category)
      VALUES ('auth', 'document', '{"email":"optional","whatsapp":"off","channels":["email"]}', 'json', 'customer_auth');
  `);
  // 100 single-SKU products for the 20- and 99-line carts, at whole-taka
  // prices: cash on delivery collects whole taka, so a paisa total is refused.
  const insertProduct = sqlite.prepare("INSERT INTO products (id, name, price_minor, slug, category_id, is_active) VALUES (?, ?, ?, ?, 'cat_panjabi', 1)");
  const insertVariant = sqlite.prepare(`INSERT INTO product_variants
    (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
    VALUES (?, ?, ?, ?, 100000, 0, 0, 1, 1, 'physical')`);
  for (let index = 1; index <= CATALOG_LINES; index += 1) {
    insertProduct.run(`p_bulk_${index}`, `Bulk item ${index}`, 10000 + index * 100, `bulk-item-${index}`);
    insertVariant.run(`v_bulk_${index}`, `p_bulk_${index}`, `BULK-${index}`, 10000 + index * 100);
  }
}

export function seedOrders(sqlite: DatabaseSync, count: number): void {
  sqlite.exec(`
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
    INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone,
      subtotal_amount_minor, total_amount_minor, subtotal_shop_minor, total_shop_minor, status, created_at, updated_at)
    SELECT 'ord_seed_' || i, 'Buyer ' || i, '+88017' || printf('%08d', i), 'House 1, Road 2, Gulshan', 'city_1', 'zone_1',
      10000, 10000, 10000, 10000, 'confirmed', 1790000000 + i * 60, 1790000000 + i * 60
    FROM n;
  `);
}

/** Images that still publish only their original: the rendition backlog the cron fans out. */
export function seedMediaBacklog(sqlite: DatabaseSync, count: number): void {
  sqlite.exec(`
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
    INSERT INTO media (id, filename, kind, object_key, size, mime_type, status, width, height, created_at, updated_at)
    SELECT 'media_backlog_' || i, 'b' || i || '.jpg', 'image', 'media/b' || i || '.jpg', 1000, 'image/jpeg', 'ready', 1600, 1600, 1700000000, 1700000000
    FROM n;
  `);
}

/** `lines` distinct single-SKU cart lines at the catalogue's prices. */
export function cartItems(lines: number) {
  return Array.from({ length: lines }, (_, index) => ({
    productId: `p_bulk_${index + 1}`,
    variantId: `v_bulk_${index + 1}`,
    quantity: 1,
    price: 100 + index + 1,
  }));
}
