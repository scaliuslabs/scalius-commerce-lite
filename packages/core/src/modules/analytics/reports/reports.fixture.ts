// Test-only fixture: a migrated in-memory store with helpers that insert
// orders, lines, returns, payments, COD tracking and parcels with known
// money, so metric tests can state their expected answers exactly.
import type { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { NO_PHONE } from "@scalius/shared/customer-auth-policy";

export interface FixtureLine {
  id: string;
  productId: string;
  variantId?: string | null;
  quantity: number;
  unitMinor: number;
  discountMinor?: number;
  taxMinor?: number;
  fulfillmentType?: "ship" | "pickup" | "digital" | "gift_card" | "service";
  /** Units handed over (return lines need some). Defaults to the quantity for shipped lines. */
  fulfilledQuantity?: number;
  productName?: string;
  variantLabel?: string | null;
}

export interface FixtureOrder {
  id: string;
  /** An ISO instant (with offset) or epoch seconds. */
  createdAt: string | number;
  status?: string;
  paymentMethod?: string;
  paymentStatus?: string;
  channel?: string;
  channelSource?: string | null;
  customerId?: string | null;
  customerPhone?: string;
  customerName?: string;
  currencyCode?: string;
  pricesIncludeTax?: boolean;
  shippingMinor?: number;
  /** Order discount; defaults to the line discounts (no shipping discount). */
  discountMinor?: number;
  /** Order tax; defaults to the line taxes (no shipping tax). */
  taxMinor?: number;
  paidMinor?: number;
  cityName?: string | null;
  zoneName?: string | null;
  shippingMethodId?: string | null;
  shippingMethodKind?: "delivery" | "pickup" | null;
  requiresShipping?: boolean;
  fulfillmentLocationId?: string | null;
  fulfillmentStatus?: string;
  deletedAt?: number | null;
  lines: FixtureLine[];
}

export interface AnalyticsFixture {
  sqlite: DatabaseSync;
  db: Database;
  epoch(value: string | number): number;
  category(id: string, name: string): void;
  brand(id: string, name: string): void;
  product(id: string, name: string, options?: { categoryId?: string | null; brandId?: string | null }): void;
  variant(id: string, productId: string, sku: string, options?: { priceMinor?: number; stock?: number; trackInventory?: boolean; lowStockThreshold?: number | null; isDefault?: boolean }): void;
  customer(id: string, name: string, phone: string, createdAt?: string | number): void;
  order(order: FixtureOrder): void;
  returnCase(input: { id: string; orderId: string; status: string; lines: Array<{ itemId: string; variantId?: string | null; approved: number; requested?: number }> }): void;
  payment(input: { id: string; orderId: string; amountMinor: number; method?: string; type?: string; status?: string; createdAt?: string | number }): void;
  cod(input: { orderId: string; status: string; collectedMinor?: number | null; collectedAt?: string | number | null }): void;
  shipment(input: { id: string; orderId: string; status: string; courier?: string; providerType?: string; createdAt?: string | number }): void;
  close(): void;
}

export function createAnalyticsFixture(): AnalyticsFixture {
  const { sqlite, db } = createSqliteD1Database();
  const epoch = (value: string | number) => typeof value === "number" ? value : Math.floor(Date.parse(value) / 1000);
  const customers = new Set<string>();
  const products = new Set<string>();

  const fixture: AnalyticsFixture = {
    sqlite,
    db,
    epoch,
    category(id, name) {
      sqlite.prepare(`INSERT INTO categories (id, name, slug, status) VALUES (?, ?, ?, 'published')`).run(id, name, id);
    },
    brand(id, name) {
      sqlite.prepare(`INSERT INTO brands (id, name, slug, status) VALUES (?, ?, ?, 'published')`).run(id, name, id.replace(/_/g, "-"));
    },
    product(id, name, options = {}) {
      products.add(id);
      sqlite.prepare(`
        INSERT INTO products (id, name, slug, price_minor, category_id, brand_id, is_active)
        VALUES (?, ?, ?, 0, ?, ?, 1)
      `).run(id, name, id, options.categoryId ?? null, options.brandId ?? null);
    },
    variant(id, productId, sku, options = {}) {
      sqlite.prepare(`
        INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory, low_stock_threshold)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        productId,
        sku,
        options.priceMinor ?? 0,
        options.stock ?? 0,
        options.isDefault === false ? 0 : 1,
        options.trackInventory === false ? 0 : 1,
        options.lowStockThreshold ?? null,
      );
    },
    customer(id, name, phone, createdAt = "2026-01-01T00:00:00+06:00") {
      customers.add(id);
      sqlite.prepare(`INSERT INTO customers (id, name, phone, created_at) VALUES (?, ?, ?, ?)`).run(id, name, phone, epoch(createdAt));
    },
    order(order) {
      for (const line of order.lines) {
        if (!products.has(line.productId)) fixture.product(line.productId, line.productName ?? line.productId);
      }
      if (order.customerId && !customers.has(order.customerId)) {
        fixture.customer(order.customerId, order.customerName ?? "Buyer", order.customerPhone ?? "+8801711000000");
      }
      // Checkout attaches every order to a customer, a guest record keyed by
      // phone (NO_PHONE: none here). `customerId: null` models a customer
      // hard-deleted since (FK SET NULL): the order is its own customer.
      const phone = order.customerPhone ?? "+8801711000000";
      let customerId = order.customerId;
      if (customerId === undefined && phone !== NO_PHONE) {
        customerId = (sqlite.prepare("SELECT id FROM customers WHERE phone = ? AND deleted_at IS NULL ORDER BY id LIMIT 1").get(phone)?.id as string | undefined)
          ?? `guest_${phone.replace(/\W/g, "")}`;
        if (!customers.has(customerId)) fixture.customer(customerId, order.customerName ?? "Buyer", phone);
      }
      const subtotal = order.lines.reduce((sum, line) => sum + line.unitMinor * line.quantity, 0);
      const lineDiscount = order.lines.reduce((sum, line) => sum + (line.discountMinor ?? 0), 0);
      const lineTax = order.lines.reduce((sum, line) => sum + (line.taxMinor ?? 0), 0);
      const shipping = order.shippingMinor ?? 0;
      const discount = order.discountMinor ?? lineDiscount;
      const tax = order.taxMinor ?? lineTax;
      const total = subtotal + shipping - discount + (order.pricesIncludeTax ? 0 : tax);
      const paid = order.paidMinor ?? 0;
      const requiresShipping = order.requiresShipping ?? true;
      sqlite.prepare(`
        INSERT INTO orders (id, customer_name, customer_phone, customer_id, shipping_address, city, zone,
          city_name, zone_name, currency_code, subtotal_amount_minor, shipping_amount_minor, discount_amount_minor,
          tax_amount_minor, total_amount_minor, shop_currency, subtotal_shop_minor, shipping_shop_minor,
          discount_shop_minor, tax_shop_minor, total_shop_minor, prices_include_tax, status, payment_method, payment_status,
          paid_amount_minor, balance_due_minor, fulfillment_status, shipping_method_id, shipping_method_kind,
          requires_shipping, fulfillment_location_id, channel, channel_source, created_at, updated_at, deleted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        order.id,
        order.customerName ?? "Buyer",
        phone,
        customerId ?? null,
        requiresShipping ? "Road 1" : null,
        requiresShipping ? "city_dhaka" : null,
        requiresShipping ? "zone_1" : null,
        order.cityName === undefined ? (requiresShipping ? "Dhaka" : null) : order.cityName,
        order.zoneName ?? null,
        order.currencyCode ?? "BDT",
        subtotal,
        shipping,
        discount,
        tax,
        total,
        // Same-currency orders, as checkout writes them: shop amounts = presentment amounts.
        order.currencyCode ?? "BDT",
        subtotal,
        shipping,
        discount,
        tax,
        total,
        order.pricesIncludeTax ? 1 : 0,
        order.status ?? "pending",
        order.paymentMethod ?? "cod",
        order.paymentStatus ?? (paid >= total ? "paid" : paid > 0 ? "partial" : "unpaid"),
        paid,
        total - paid,
        order.fulfillmentStatus ?? "pending",
        order.shippingMethodId ?? null,
        order.shippingMethodKind ?? null,
        requiresShipping ? 1 : 0,
        order.fulfillmentLocationId ?? null,
        order.channel ?? "online_store",
        order.channelSource ?? null,
        epoch(order.createdAt),
        epoch(order.createdAt),
        order.deletedAt ?? null,
      );
      for (const line of order.lines) {
        const fulfillmentType = line.fulfillmentType ?? "ship";
        sqlite.prepare(`
          INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, product_name, variant_label,
            unit_price_minor, line_subtotal_minor, discount_amount_minor, taxable_amount_minor, tax_amount_minor,
            fulfillment_type, fulfilled_quantity, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          line.id,
          order.id,
          line.productId,
          line.variantId ?? null,
          line.quantity,
          line.productName ?? line.productId,
          line.variantLabel ?? null,
          line.unitMinor,
          line.unitMinor * line.quantity,
          line.discountMinor ?? 0,
          0,
          line.taxMinor ?? 0,
          fulfillmentType,
          line.fulfilledQuantity ?? (fulfillmentType === "ship" ? line.quantity : 0),
          epoch(order.createdAt),
        );
      }
    },
    returnCase(input) {
      sqlite.prepare(`
        INSERT INTO order_returns (id, order_id, status, reason, actor_type, source)
        VALUES (?, ?, 'requested', 'Changed mind', 'admin', 'admin')
      `).run(input.id, input.orderId);
      for (const [index, line] of input.lines.entries()) {
        sqlite.prepare(`
          INSERT INTO order_return_lines (id, return_id, order_id, order_item_id, variant_id, inventory_tracked,
            requested_quantity, approved_quantity)
          VALUES (?, ?, ?, ?, ?, 0, ?, 0)
        `).run(`${input.id}_l${index}`, input.id, input.orderId, line.itemId, line.variantId ?? null, line.requested ?? line.approved);
      }
      const path: Record<string, string[]> = {
        requested: [],
        approved: ["approved"],
        receiving: ["approved", "receiving"],
        completed: ["approved", "completed"],
        rejected: ["rejected"],
        cancelled: ["cancelled"],
      };
      if (path[input.status]?.[0] === "approved") {
        for (const [index, line] of input.lines.entries()) {
          sqlite.prepare(`UPDATE order_return_lines SET approved_quantity = ? WHERE id = ?`).run(line.approved, `${input.id}_l${index}`);
        }
      }
      for (const status of path[input.status] ?? []) {
        sqlite.prepare(`UPDATE order_returns SET status = ? WHERE id = ?`).run(status, input.id);
      }
    },
    payment(input) {
      sqlite.prepare(`
        INSERT INTO order_payments (id, order_id, amount_minor, currency, payment_method, payment_type, status, created_at, updated_at)
        VALUES (?, ?, ?, 'BDT', ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.orderId,
        input.amountMinor,
        input.method ?? "cod",
        input.type ?? "full",
        input.status ?? "confirmed",
        epoch(input.createdAt ?? "2026-08-01T00:00:00+06:00"),
        epoch(input.createdAt ?? "2026-08-01T00:00:00+06:00"),
      );
    },
    cod(input) {
      sqlite.prepare(`
        INSERT INTO cod_tracking (id, order_id, cod_status, collected_amount_minor, collected_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        `cod_${input.orderId}`,
        input.orderId,
        input.status,
        input.collectedMinor ?? null,
        input.collectedAt === undefined || input.collectedAt === null ? null : epoch(input.collectedAt),
      );
    },
    shipment(input) {
      sqlite.prepare(`
        INSERT INTO delivery_shipments (id, order_id, provider_type, courier_name, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.orderId,
        input.providerType ?? "manual",
        input.courier ?? null,
        input.status,
        epoch(input.createdAt ?? "2026-08-01T00:00:00+06:00"),
        epoch(input.createdAt ?? "2026-08-01T00:00:00+06:00"),
      );
    },
    close() {
      sqlite.close();
    },
  };
  return fixture;
}
