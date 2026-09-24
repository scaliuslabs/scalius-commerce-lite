import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { withPublicMediaUrl } from "../../../integrations/storage";
import { archiveOrders } from "./archive";
import { getOrderDetails } from "./detail";
import { listOrders } from "./list";
import { previewOrderPaymentRecoveryLink } from "./recovery-link";

type Query = { sql: string; params: readonly unknown[] };

describe("admin order recovery lifecycle", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let queries: Query[];
  const now = Math.floor(Date.now() / 1000);

  beforeEach(() => {
    queries = [];
    // Executes the public service's actual filters, count, pagination,
    // projections and enrichment queries against the migrated schema.
    ({ sqlite, db } = createSqliteD1Database({
      onQuery: (sql, params) => queries.push({ sql, params }),
    }));
  });

  afterEach(() => sqlite.close());

  function order(id: string, status = "cancelled", paymentStatus = "failed", paidAmount = 0) {
    sqlite.prepare(`INSERT INTO orders (
      id, customer_name, customer_phone, shipping_address, city, zone,
      total_amount_minor, shipping_amount_minor, payment_method, status, payment_status,
      paid_amount_minor, balance_due_minor, currency_code, currency_decimal_places
    ) VALUES (?, 'Recovery buyer', '+8801700000000', 'Test address', 'city', 'zone',
      10000, 0, 'sslcommerz', ?, ?, ?, ?, 'BDT', 2)`)
      .run(id, status, paymentStatus, paidAmount, 100 - paidAmount);
  }

  function attempt(orderId: string, status = "failed", claimExpiresAt: number | null = null) {
    sqlite.prepare(`INSERT INTO payment_session_attempts (
      id, attempt_key, order_id, gateway, payment_type, amount_minor, currency,
      request_hash, status, attempts, claim_expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'sslcommerz', 'full', 10000, 'BDT', 'test-hash', ?, 1, ?, ?, ?)`)
      .run(`attempt_${orderId}`, `key_${orderId}`, orderId, status, claimExpiresAt, now - 300, now - 100);
  }

  async function shipmentRecovery(status: string, rawStatus: string | null, activeClaim: boolean, externalId: string | null = null) {
    order("shipment_order", "confirmed", "paid", 100);
    sqlite.prepare(`INSERT INTO delivery_providers (id, name, type, credentials, config)
      VALUES ('provider', 'Test courier', 'pathao', '{}', '{}')`).run();
    sqlite.prepare(`INSERT INTO delivery_shipments (id, order_id, provider_id, provider_type, status, raw_status, external_id)
      VALUES ('shipment', 'shipment_order', 'provider', 'pathao', ?, ?, ?)`)
      .run(status, rawStatus, externalId);
    sqlite.prepare(`UPDATE orders SET shipment_claim_id = 'shipment', shipment_claim_expires_at = ? WHERE id = 'shipment_order'`)
      .run(activeClaim ? now + 300 : now - 300);
    const list = await listOrders(db, {});
    const detail = await getOrderDetails(db, "shipment_order");
    expect(detail?.shipmentRecovery).toEqual(list.orders[0]?.shipmentRecovery);
    return detail!.shipmentRecovery;
  }

  it.each([
    { status: "creating", activeClaim: true },
    { status: "reconcile_required", activeClaim: false },
  ])("keeps an unknown courier outcome locked after $status in list and detail", async ({ status, activeClaim }) => {
    const recovery = await shipmentRecovery(status, "provider_outcome_unknown", activeClaim);
    expect(recovery).toMatchObject({
      state: "needs_attention", reason: "courier_unconfirmed", severity: "danger", activeLock: true,
      label: "Courier confirmation needed", shipmentId: "shipment",
      canRepair: false, canRefresh: false, canRetryCreate: false, unknownOutcome: true,
    });
    expect(recovery.message).toMatch(/check the courier portal or contact the courier/i);
    expect(recovery.message).not.toMatch(/repair|automatically|wait for it to finish/i);
  });

  it("retains repair for a confirmed provider result with incomplete local finalization", async () => {
    const recovery = await shipmentRecovery("reconcile_required", "pending", false, "consignment_confirmed");
    expect(recovery).toMatchObject({
      state: "needs_attention", reason: "reconcile_required", activeLock: true, canRepair: true, canRefresh: true, canRetryCreate: false, unknownOutcome: false,
    });
  });

  it.each([
    { status: "creating", activeClaim: true, state: "creating", canRetryCreate: false },
    { status: "pending", activeClaim: false, state: "needs_attention", canRetryCreate: false },
    { status: "failed", activeClaim: false, state: "failed", canRetryCreate: true },
  ])("does not offer repair for ordinary $status shipments", async ({ status, activeClaim, state, canRetryCreate }) => {
    expect(await shipmentRecovery(status, null, activeClaim)).toMatchObject({ state, canRepair: false, canRetryCreate });
  });

  it("defaults repair to false when the order has no shipment recovery", async () => {
    order("unshipped", "confirmed", "paid", 100);
    const list = await listOrders(db, {});
    const detail = await getOrderDetails(db, "unshipped");
    expect(detail?.shipmentRecovery).toEqual(list.orders[0]?.shipmentRecovery);
    expect(detail?.shipmentRecovery).toMatchObject({ state: "none", canRepair: false });
    expect(detail?.version).toBe(1);
  });

  function payment(orderId: string, status: string, paymentType = "full", amount = 100) {
    const id = `payment_${orderId}_${paymentType}`;
    sqlite.prepare(`INSERT INTO order_payments
      (id, order_id, amount_minor, currency, payment_method, payment_type, status)
      VALUES (?, ?, ?, 'BDT', 'sslcommerz', ?, ?)`).run(id, orderId, amount, paymentType, status);
    return id;
  }

  function refund(orderId: string, status: string, amount = 25) {
    const source = payment(orderId, "succeeded");
    const target = payment(orderId, status === "refunded" ? "refunded" : "pending", "refund", amount);
    sqlite.prepare(`INSERT INTO refund_attempts (
      id, attempt_key, refund_group_id, order_id, source_payment_id, refund_payment_id,
      gateway, amount_minor, currency, reason, request_hash, provider_idempotency_key,
      refund_reference, status
    ) VALUES (?, ?, ?, ?, ?, ?, 'sslcommerz', ?, 'BDT', 'test', 'test-hash', ?, ?, ?)`)
      .run(`refund_${orderId}`, `refund_key_${orderId}`, `group_${orderId}`, orderId,
        source, target, amount, `provider_${orderId}`, `reference_${orderId}`, status);
  }

  async function expectRecovery(id: string, state: string) {
    const list = await listOrders(db, {});
    const row = list.orders.find((candidate) => candidate.id === id);
    const detail = await getOrderDetails(db, id);
    expect(row?.paymentRecovery.state).toBe(state);
    expect(detail?.paymentRecovery).toEqual(row?.paymentRecovery);
    expect(row).not.toHaveProperty("paymentRecoveryApplicable");
    expect(detail).not.toHaveProperty("paymentRecoveryApplicable");
    expect(JSON.stringify([row?.paymentRecovery, detail?.paymentRecovery])).not.toMatch(/key_|test-hash|claim/);
    if (state !== "none" && row?.status !== "incomplete") {
      expect(row?.paymentRecovery.message).not.toMatch(/retry/i);
    }
    const queue = await listOrders(db, { paymentRecovery: "recoverable" });
    expect(queue.orders.some((candidate) => candidate.id === id)).toBe(state !== "none");
    expect(queue.pagination.total).toBe(state === "none" ? 0 : 1);
    return detail;
  }

  it.each(["cancelled", "returned", "refunded", "partially_refunded"])(
    "removes settled %s failures from the list summary, detail, queue and count",
    async (kind) => {
      // A partial refund keeps the order delivered; only the payment reads "partially refunded".
      const isPartial = kind === "partially_refunded";
      const paymentStatus = isPartial ? "partially_refunded" : kind === "refunded" ? "refunded" : "failed";
      order("closed", isPartial ? "delivered" : kind, paymentStatus, isPartial ? 75 : 0);
      attempt("closed");
      if (kind === "refunded" || isPartial) refund("closed", "refunded", isPartial ? 25 : 100);
      const detail = await expectRecovery("closed", "none");
      expect(detail?.paymentStatus).toBe(paymentStatus);
      expect(sqlite.prepare("SELECT status FROM payment_session_attempts").get()?.status).toBe("failed");
      await expect(previewOrderPaymentRecoveryLink(db, "closed"))
        .rejects.toThrow("Only incomplete hosted-payment orders");
    },
  );

  it("keeps incomplete failed and unpaid checkouts while filtering before pagination", async () => {
    order("closed");
    attempt("closed");
    order("failed", "incomplete");
    attempt("failed");
    order("unpaid", "incomplete", "unpaid");
    const first = await listOrders(db, { paymentRecovery: "recoverable", limit: 1, page: 1, sort: "createdAt", order: "asc" });
    const second = await listOrders(db, { paymentRecovery: "recoverable", limit: 1, page: 2, sort: "createdAt", order: "asc" });
    expect(first.pagination).toMatchObject({ total: 2, totalPages: 2 });
    expect(first.orders[0]?.id).toBe("failed");
    expect(first.orders[0]?.paymentRecovery.state).toBe("needs_attention");
    expect(second.orders[0]?.id).toBe("unpaid");
    expect(second.orders[0]?.paymentRecovery.state).toBe("awaiting_payment");
    expect((await previewOrderPaymentRecoveryLink(db, "failed")).paymentRecovery.state).toBe("needs_attention");
  });

  it.each([
    [now + 300, "processing"],
    [now - 300, "needs_attention"],
    [null, "needs_attention"],
  ] as const)("preserves closed setup with lease %s", async (lease, state) => {
    order("closed", "cancelled", "unpaid");
    attempt("closed", "processing", lease);
    await expectRecovery("closed", state);
  });

  it.each(["pending", "confirmed"])("preserves %s payment reconciliation on closed orders", async (status) => {
    order("closed");
    attempt("closed");
    payment("closed", status);
    await expectRecovery("closed", "needs_attention");
  });

  it.each(["cancelled", "returned"])("preserves captured money on %s orders", async (status) => {
    order("closed", status, "failed", 75);
    attempt("closed");
    payment("closed", "succeeded", "full", 75);
    await expectRecovery("closed", "needs_attention");
  });

  it.each(["pending", "processing", "provider_unknown", "reconcile_required"])("preserves %s refunds on closed orders", async (status) => {
    order("closed", "delivered", "partially_refunded", 75);
    attempt("closed");
    refund("closed", status);
    await expectRecovery("closed", "needs_attention");
  });

  it("preserves a pending refund payment without an attempt row", async () => {
    order("closed");
    attempt("closed");
    payment("closed", "pending", "refund", 25);
    await expectRecovery("closed", "needs_attention");
  });

  it.each(["processing", "queued", "failed", "manual_reconciliation", "processed"])("classifies closed payment webhook status %s", async (status) => {
    order("closed");
    attempt("closed");
    sqlite.prepare("INSERT INTO webhook_events (id, order_id, provider, event_type, status) VALUES ('event', 'closed', 'stripe', 'payment_intent.succeeded', ?)").run(status);
    await expectRecovery("closed", status === "processed" ? "none" : "needs_attention");
  });

  it("keeps a clamped full filtered page inside D1 bind limits and uses order-id evidence indexes", async () => {
    for (let index = 0; index < 101; index++) order(`open_${index}`, "incomplete");
    const result = await listOrders(db, {
      paymentRecovery: "recoverable", search: "+8801700000000", limit: 1000, page: 0,
      status: "incomplete", paymentStatus: "failed", paymentMethod: "sslcommerz",
      fulfillmentStatus: "pending", startDate: new Date(0), endDate: new Date("2100-01-01"),
      sort: "relevance", order: "desc",
    });
    expect(result.orders).toHaveLength(100);
    expect(result.pagination).toMatchObject({ page: 1, limit: 100, total: 101 });
    expect(Math.max(...queries.map((query) => query.params.length))).toBeLessThanOrEqual(100);
    const orderQuery = queries.find((query) => query.sql.includes('"webhook_events"'));
    expect(orderQuery).toBeDefined();
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${orderQuery!.sql}`).all(...orderQuery!.params as SQLInputValue[]);
    expect(plan.map((step) => String(step.detail)).join("\n")).toContain("webhook_events_order_id_idx");
  });

  it("archives only settled orders at the loaded version without touching inventory or live payment setup", async () => {
    order("done", "completed", "paid", 100);
    order("busy", "completed", "paid", 100);
    attempt("busy", "processing", now + 300);
    order("open", "confirmed", "unpaid");

    await expect(archiveOrders(db, [{ id: "done", expectedVersion: 2 }])).rejects.toThrow(/changed/);
    await expect(archiveOrders(db, [{ id: "busy", expectedVersion: 1 }])).rejects.toThrow();
    await expect(archiveOrders(db, [{ id: "open", expectedVersion: 1 }])).rejects.toThrow();
    queries = [];
    await archiveOrders(db, [{ id: "done", expectedVersion: 1 }]);

    expect(queries.some((query) => /product_variants|inventory_movements|DELETE FROM/i.test(query.sql))).toBe(false);
    expect(sqlite.prepare("SELECT id, version, archived_at IS NOT NULL AS archived, status FROM orders ORDER BY id").all())
      .toEqual([
        { id: "busy", version: 1, archived: 0, status: "completed" },
        { id: "done", version: 2, archived: 1, status: "completed" },
        { id: "open", version: 1, archived: 0, status: "confirmed" },
      ]);
  });

  it("shows the image snapshotted on the order line, not the product's current media", async () => {
    order("history", "completed", "paid", 100);
    sqlite.exec(`
      INSERT INTO products (id, name, slug, price_minor) VALUES ('product_h', 'Renamed product', 'renamed', 10000);
      INSERT INTO media (id, filename, kind, object_key, size, mime_type) VALUES
        ('med_snapshot0001', 'old.webp', 'image', 'media/med_snapshot0001.webp', 1, 'image/webp'),
        ('med_current00001', 'new.webp', 'image', 'media/med_current00001.webp', 1, 'image/webp');
      INSERT INTO product_media (id, product_id, media_id, is_primary, sort_order)
        VALUES ('pmed_current01', 'product_h', 'med_current00001', 1, 0);
      INSERT INTO order_items (id, order_id, product_id, quantity, unit_price_minor, product_name, product_image_media_id)
        VALUES ('item_h', 'history', 'product_h', 1, 10000, 'Original name', 'med_snapshot0001');
    `);
    const detail = await withPublicMediaUrl("https://media.example", () => getOrderDetails(db, "history"));
    expect(detail?.items).toEqual([expect.objectContaining({
      productName: "Original name",
      productImage: "https://media.example/media/med_snapshot0001.webp",
    })]);
  });
});
