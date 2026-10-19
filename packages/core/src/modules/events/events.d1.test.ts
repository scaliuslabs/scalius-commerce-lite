// Event outbox dispatch and webhook delivery on the real migrated schema:
// events come from the SQL triggers, dispatch is idempotent per event id,
// deliveries are signed, retried with backoff, exhausted after 8 attempts,
// and an endpoint failing for a day is turned off.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { buildEventRepresentation, verifyWebhookSignature, type EventEnvelope } from "@scalius/shared/events";
import { allProtectedData } from "@scalius/shared/plugins/protected-data";
import {
  EVENT_FAN_OUT_TARGETS,
  MAX_EVENT_DISPATCH_ATTEMPTS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_SECONDS,
  createWebhookSubscription,
  deleteWebhookSubscription,
  dispatchPendingEvents,
  listDueWebhookDeliveries,
  listRecentEvents,
  listWebhookDeliveries,
  maskResponseExcerpt,
  processEventDispatch,
  processWebhookDelivery,
  pruneEventsAndDeliveries,
  readWebhookSecret,
  retryWebhookDelivery,
  rotateWebhookSecret,
  sendWebhookTest,
  updateWebhookSubscription,
  webhookRetryDelaySeconds,
  type EventFanOutTarget,
  type WebhookFetch,
} from "./index";

const ENCRYPTION_KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)).toString("base64");

function insertOrder(sqlite: DatabaseSync, id: string, status = "pending"): void {
  sqlite.prepare(`INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status)
    VALUES (?, 'Rahim', '+8801711111111', 'House 1', 'city_1', 'zone_1', ?)`).run(id, status);
}

function eventIds(sqlite: DatabaseSync, topic?: string): string[] {
  return (sqlite.prepare(`SELECT id FROM event_outbox ${topic ? "WHERE topic = ?" : ""} ORDER BY id`)
    .all(...(topic ? [topic] : [])) as Array<{ id: string }>).map((row) => row.id);
}

const ORDER_REPRESENTATION = buildEventRepresentation("order", {
  id: "ord_1", orderNumber: 1, status: "pending", paymentStatus: "unpaid", fulfillmentStatus: "unfulfilled", channel: "online_store",
  salesChannelId: "sc_online_store", marketId: null, currency: "BDT", subtotalMinor: 1000, shippingMinor: 0, discountMinor: 0, taxMinor: 0,
  totalMinor: 1000, paidMinor: 0, balanceDueMinor: 1000, pricesIncludeTax: false, paymentMethod: "cod", customerId: null, accountCustomerId: null,
  contact: { name: "Rahim", email: "rahim@buyer.test", phone: "+8801711111111" },
  requiresShipping: true, shippingMethodId: null,
  shippingAddress: {
    name: "Rahim", phone: "+8801711111111", company: null, line1: "House 1", line2: null, dependentLocality: null,
    locality: "Dhaka", adminArea: null, postalCode: null, countryCode: "BD", placeIds: { city: "city", zone: "zone", area: null },
  },
  billingAddress: null, fulfillmentLocationId: null, version: 1, lines: [],
  createdAt: "2026-10-19T00:00:00.000Z", updatedAt: "2026-10-19T00:00:00.000Z", deletedAt: null,
}, allProtectedData());
const representation = vi.fn(async () => ORDER_REPRESENTATION);

describe("event outbox dispatch", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    sqlite.exec("INSERT INTO event_demand (filter) VALUES ('order.*')");
    representation.mockClear();
  });
  afterEach(() => sqlite.close());

  it("writes no events and makes only the empty indexed read while nobody subscribes", async () => {
    sqlite.exec("DELETE FROM event_demand");
    insertOrder(sqlite, "ord_1");
    const result = await dispatchPendingEvents({ db, targets: EVENT_FAN_OUT_TARGETS });
    expect(result).toMatchObject({ scanned: 0, dispatched: 0, deliveries: [] });
    expect(sqlite.prepare("SELECT count(*) AS n FROM event_outbox").get()).toEqual({ n: 0 });
  });

  it("reads a backlog by bounded index walks and drains only the requested batch", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    sqlite.close();
    ({ sqlite, db } = createSqliteD1Database({ onQuery: (sql, params) => queries.push({ sql, params: [...params] }) }));
    sqlite.exec("INSERT INTO event_demand (filter) VALUES ('order.*')");
    for (let index = 0; index < 60; index += 1) insertOrder(sqlite, `ord_${index}`);
    queries.length = 0;
    const result = await dispatchPendingEvents({ db, targets: EVENT_FAN_OUT_TARGETS, limit: 2 });
    expect(result.dispatched).toBe(2);
    const query = queries.find((query) => query.sql.includes("event_outbox") && query.sql.includes("UNION ALL"))!;
    const plan = (sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...(query.params as never[])) as Array<{ detail: string }>)
      .map((step) => step.detail.replace("USING COVERING INDEX", "USING INDEX"));
    expect(plan.filter((step) => /^(SCAN|SEARCH) event_outbox\b/.test(step))).toEqual([
      "SEARCH event_outbox USING INDEX sqlite_autoindex_event_outbox_1 (id=?)",
      "SEARCH event_outbox USING INDEX event_outbox_due_idx (status=? AND next_attempt_at<?)",
      "SEARCH event_outbox USING INDEX event_outbox_due_idx (status=? AND next_attempt_at<?)",
      "SEARCH event_outbox USING INDEX event_outbox_claim_idx (status=? AND claim_expires_at<?)",
    ]);
  });

  it("dispatches due events, fans out once per subscription and event, and is idempotent on redelivery", async () => {
    const { subscription } = await createWebhookSubscription(db, {
      url: "https://hooks.example.com/orders",
      topics: ["order.*"],
    }, { actorId: null, encryptionKey: ENCRYPTION_KEY });
    await createWebhookSubscription(db, {
      url: "https://hooks.example.com/products",
      topics: ["product.created"],
    }, { actorId: null, encryptionKey: ENCRYPTION_KEY });
    insertOrder(sqlite, "ord_1");
    const [eventId] = eventIds(sqlite);

    const flushed = await dispatchPendingEvents({ db, targets: EVENT_FAN_OUT_TARGETS });
    expect(flushed).toMatchObject({ scanned: 1, dispatched: 1 });
    expect(sqlite.prepare("SELECT status FROM event_outbox").get()).toEqual({ status: "dispatched" });
    const deliveries = sqlite.prepare("SELECT id, subscription_id, event_id, topic, resource_type, resource_id, status FROM webhook_event_deliveries").all() as Array<Record<string, string>>;
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ subscription_id: subscription.id, event_id: eventId, topic: "order.created", resource_type: "order", resource_id: "ord_1", status: "pending" });
    // Ids only: the drain sends the recorded delivery next.
    expect(flushed.deliveries).toEqual([{ type: "webhooks.deliver", deliveryId: deliveries[0]!.id }]);

    // A dispatched event is never dispatched again.
    await expect(processEventDispatch({ db, eventId: eventId!, targets: EVENT_FAN_OUT_TARGETS }))
      .resolves.toMatchObject({ status: "skipped", reason: "already_dispatched" });
    // A dispatch whose invocation died is reclaimed once its lease ends and adds no duplicate delivery.
    sqlite.exec("UPDATE event_outbox SET status = 'processing', claim_expires_at = unixepoch() + 60");
    await expect(dispatchPendingEvents({ db, targets: EVENT_FAN_OUT_TARGETS })).resolves.toMatchObject({ scanned: 0 });
    sqlite.exec("UPDATE event_outbox SET claim_expires_at = unixepoch() - 1");
    await expect(dispatchPendingEvents({ db, targets: EVENT_FAN_OUT_TARGETS })).resolves.toMatchObject({ scanned: 1, dispatched: 1 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM webhook_event_deliveries").get()).toEqual({ n: 1 });
  });

  it("does not deliver events that happened before the endpoint existed", async () => {
    insertOrder(sqlite, "ord_old");
    sqlite.exec("UPDATE event_outbox SET occurred_at = occurred_at - 600");
    await createWebhookSubscription(db, { url: "https://hooks.example.com/x", topics: ["*"] }, { actorId: null, encryptionKey: ENCRYPTION_KEY });
    const [eventId] = eventIds(sqlite);
    await processEventDispatch({ db, eventId: eventId!, targets: EVENT_FAN_OUT_TARGETS });
    expect(sqlite.prepare("SELECT count(*) AS n FROM webhook_event_deliveries").get()).toEqual({ n: 0 });
  });

  it("retries a failing target with backoff and dead-letters after the attempt limit", async () => {
    insertOrder(sqlite, "ord_1");
    const [eventId] = eventIds(sqlite);
    const broken: EventFanOutTarget = {
      name: "broken",
      hasSubscribers: async () => true,
      fanOut: async () => { throw new Error("subscriber store unavailable"); },
    };
    const first = await processEventDispatch({ db, eventId: eventId!, targets: [broken] });
    expect(first).toMatchObject({ status: "failed" });
    expect(sqlite.prepare("SELECT status, attempts, next_attempt_at > unixepoch() AS later FROM event_outbox").get())
      .toEqual({ status: "failed", attempts: 1, later: 1 });
    sqlite.exec(`UPDATE event_outbox SET attempts = ${MAX_EVENT_DISPATCH_ATTEMPTS - 1}, next_attempt_at = 0`);
    await expect(processEventDispatch({ db, eventId: eventId!, targets: [broken] }))
      .resolves.toMatchObject({ status: "dead_lettered" });
  });

  it("lists recent events newest first with a cursor", async () => {
    insertOrder(sqlite, "ord_1");
    insertOrder(sqlite, "ord_2");
    const page = await listRecentEvents(db, { limit: 1 });
    expect(page.events).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    const next = await listRecentEvents(db, { limit: 1, cursor: page.nextCursor! });
    expect(next.events[0]!.id < page.events[0]!.id).toBe(true);
    expect(next.events[0]!.facts).toMatchObject({ orderId: expect.any(String), channel: "online_store" });
  });
});

describe("webhook deliveries", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    representation.mockClear();
  });
  afterEach(() => sqlite.close());

  async function deliveryFor(topics: string[] = ["order.created"]) {
    const created = await createWebhookSubscription(db, { url: "https://hooks.example.com/orders", topics }, {
      actorId: null,
      encryptionKey: ENCRYPTION_KEY,
    });
    insertOrder(sqlite, "ord_1");
    const [eventId] = eventIds(sqlite, "order.created");
    await processEventDispatch({ db, eventId: eventId!, targets: EVENT_FAN_OUT_TARGETS });
    const delivery = sqlite.prepare("SELECT id FROM webhook_event_deliveries").get() as { id: string };
    return { ...created, eventId: eventId!, deliveryId: delivery.id };
  }

  it("POSTs a signed envelope with the event id, topic and API version, and records success", async () => {
    const { subscription, secret, eventId, deliveryId } = await deliveryFor();
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchMock: WebhookFetch = async (url, init) => {
      captured = { url, init };
      return new Response("ok thanks, contact ops@example.com", { status: 200 });
    };
    const outcome = await processWebhookDelivery({ db, deliveryId, encryptionKey: ENCRYPTION_KEY, resolveRepresentation: representation, fetch: fetchMock });
    expect(outcome).toMatchObject({ status: "succeeded" });
    expect(captured!.url).toBe("https://hooks.example.com/orders");
    expect(captured!.init.redirect).toBe("manual");
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers["Scalius-Event-Id"]).toBe(eventId);
    expect(headers["Scalius-Topic"]).toBe("order.created");
    expect(headers["Scalius-Api-Version"]).toBe(subscription.apiVersion);
    const body = captured!.init.body as string;
    await expect(verifyWebhookSignature({ secret, header: headers["Scalius-Signature"], body })).resolves.toBe(true);
    const envelope = JSON.parse(body) as EventEnvelope;
    expect(envelope).toMatchObject({
      id: eventId,
      topic: "order.created",
      resource: { type: "order", id: "ord_1" },
      facts: { orderId: "ord_1", status: "pending", channel: "online_store" },
      data: { id: "ord_1", status: "pending", totalMinor: 1000, currency: "BDT" },
    });
    // No buyer contact data leaves the store unless the endpoint opted in (COMMERCE-HOOKS H5).
    expect(envelope.data).toMatchObject({
      contact: { name: null, email: null, phone: null },
      shippingAddress: { name: null, phone: null, line1: null, locality: "Dhaka", placeIds: { city: "city" } },
    });
    expect(representation).toHaveBeenCalledWith(expect.objectContaining({ id: eventId, resourceType: "order" }));
    const row = sqlite.prepare("SELECT status, attempts, response_status, response_excerpt FROM webhook_event_deliveries WHERE id = ?").get(deliveryId);
    expect(row).toEqual({ status: "succeeded", attempts: 1, response_status: 200, response_excerpt: "ok thanks, contact [email]" });
    expect(sqlite.prepare("SELECT failure_streak, last_success_at IS NOT NULL AS ok FROM webhook_subscriptions").get()).toEqual({ failure_streak: 0, ok: 1 });
    // A replayed message for a delivered row does nothing.
    await expect(processWebhookDelivery({ db, deliveryId, encryptionKey: ENCRYPTION_KEY, resolveRepresentation: representation, fetch: fetchMock }))
      .resolves.toMatchObject({ status: "skipped", reason: "not_due" });
  });

  it("retries failures on the backoff schedule, then exhausts after 8 attempts", async () => {
    const { deliveryId } = await deliveryFor();
    const failing: WebhookFetch = async () => new Response("upstream down", { status: 503 });
    const first = await processWebhookDelivery({ db, deliveryId, encryptionKey: ENCRYPTION_KEY, resolveRepresentation: representation, fetch: failing });
    expect(first).toMatchObject({ status: "failed", retryInSeconds: WEBHOOK_RETRY_DELAYS_SECONDS[0] });
    expect(sqlite.prepare("SELECT next_attempt_at - unixepoch() AS wait FROM webhook_event_deliveries").get()).toEqual({ wait: 60 });
    expect(sqlite.prepare("SELECT status, attempts, response_status, last_error FROM webhook_event_deliveries").get())
      .toEqual({ status: "failed", attempts: 1, response_status: 503, last_error: "http_503" });

    // Not due yet: an early attempt does nothing.
    await expect(processWebhookDelivery({ db, deliveryId, encryptionKey: ENCRYPTION_KEY, resolveRepresentation: representation, fetch: failing }))
      .resolves.toMatchObject({ status: "skipped", reason: "not_due" });

    for (let attempt = 2; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
      sqlite.exec("UPDATE webhook_event_deliveries SET next_attempt_at = 0");
      const outcome = await processWebhookDelivery({ db, deliveryId, encryptionKey: ENCRYPTION_KEY, resolveRepresentation: representation, fetch: failing });
      expect(outcome.status).toBe(attempt === WEBHOOK_MAX_ATTEMPTS ? "exhausted" : "failed");
    }
    expect(sqlite.prepare("SELECT status, attempts FROM webhook_event_deliveries").get()).toEqual({ status: "exhausted", attempts: WEBHOOK_MAX_ATTEMPTS });
    const total = WEBHOOK_RETRY_DELAYS_SECONDS.reduce((sum, delay) => sum + delay, 0);
    expect(total / 3600).toBeGreaterThan(20);
    expect(total / 3600).toBeLessThan(25);
    expect(webhookRetryDelaySeconds(99)).toBe(43_200);
  });

  it("turns an endpoint off after a day of failures and tells staff once", async () => {
    const { subscription, deliveryId } = await deliveryFor();
    const notice = vi.fn(async () => undefined);
    const failing: WebhookFetch = async () => { throw new TypeError("fetch failed"); };
    sqlite.exec(`UPDATE webhook_subscriptions SET failure_streak = 7, failing_since = unixepoch() - 86400`);
    const outcome = await processWebhookDelivery({
      db,
      deliveryId,
      encryptionKey: ENCRYPTION_KEY,
      resolveRepresentation: representation,
      fetch: failing,
      onSubscriptionDisabled: notice,
    });
    expect(outcome).toMatchObject({ status: "failed", subscriptionDisabled: true });
    expect(notice).toHaveBeenCalledWith({ id: subscription.id, url: subscription.url });
    expect(sqlite.prepare("SELECT status, disabled_reason, failure_streak FROM webhook_subscriptions").get())
      .toEqual({ status: "disabled", disabled_reason: "failing", failure_streak: 8 });
    expect(sqlite.prepare("SELECT last_error FROM webhook_event_deliveries").get()).toEqual({ last_error: "network_error: fetch failed" });

    // The next attempt for a disabled endpoint is cancelled, not sent.
    sqlite.exec("UPDATE webhook_event_deliveries SET next_attempt_at = 0");
    const fetchSpy = vi.fn(failing);
    await expect(processWebhookDelivery({ db, deliveryId, encryptionKey: ENCRYPTION_KEY, resolveRepresentation: representation, fetch: fetchSpy }))
      .resolves.toMatchObject({ status: "cancelled" });
    expect(fetchSpy).not.toHaveBeenCalled();

    // Turning it back on clears the streak.
    const enabled = await updateWebhookSubscription(db, subscription.id, { expectedVersion: subscription.version + 1, status: "active" });
    expect(enabled).toMatchObject({ status: "active", disabledReason: null, failureStreak: 0, failingSince: null });
  });

  it("does not count its own failures (secret or representation) against the endpoint", async () => {
    const { deliveryId } = await deliveryFor();
    const fetchSpy = vi.fn<WebhookFetch>(async () => new Response(null, { status: 204 }));
    const outcome = await processWebhookDelivery({
      db,
      deliveryId,
      encryptionKey: ENCRYPTION_KEY,
      resolveRepresentation: async () => { throw new Error("read replica lag"); },
      fetch: fetchSpy,
    });
    expect(outcome.status).toBe("failed");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT failure_streak FROM webhook_subscriptions").get()).toEqual({ failure_streak: 0 });
    sqlite.exec("UPDATE webhook_event_deliveries SET next_attempt_at = 0");
    await expect(processWebhookDelivery({ db, deliveryId, encryptionKey: undefined, resolveRepresentation: representation, fetch: fetchSpy }))
      .resolves.toMatchObject({ status: "failed" });
    expect(sqlite.prepare("SELECT last_error FROM webhook_event_deliveries").get()).toMatchObject({ last_error: expect.stringMatching(/^signing_secret_unreadable/) });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never follows redirects and refuses a stored private URL without retrying", async () => {
    const { deliveryId } = await deliveryFor();
    const redirecting: WebhookFetch = async () => new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/" } });
    await expect(processWebhookDelivery({ db, deliveryId, encryptionKey: ENCRYPTION_KEY, resolveRepresentation: representation, fetch: redirecting }))
      .resolves.toMatchObject({ status: "failed" });
    expect(sqlite.prepare("SELECT last_error FROM webhook_event_deliveries").get()).toMatchObject({ last_error: expect.stringMatching(/^redirect_not_followed/) });

    sqlite.exec("UPDATE webhook_subscriptions SET url = 'https://10.0.0.5/hook'");
    sqlite.exec("UPDATE webhook_event_deliveries SET next_attempt_at = 0");
    const fetchSpy = vi.fn(redirecting);
    await expect(processWebhookDelivery({ db, deliveryId, encryptionKey: ENCRYPTION_KEY, resolveRepresentation: representation, fetch: fetchSpy }))
      .resolves.toMatchObject({ status: "exhausted" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lists due retries and deliveries whose invocation died for the scheduled drain", async () => {
    const { deliveryId } = await deliveryFor();
    expect(await listDueWebhookDeliveries(db, 10)).toEqual([deliveryId]);
    sqlite.exec("UPDATE webhook_event_deliveries SET status = 'processing', claim_expires_at = unixepoch() + 60");
    expect(await listDueWebhookDeliveries(db, 10)).toEqual([]);
    sqlite.exec("UPDATE webhook_event_deliveries SET claim_expires_at = unixepoch() - 1");
    expect(await listDueWebhookDeliveries(db, 10)).toEqual([deliveryId]);
    sqlite.exec("UPDATE webhook_event_deliveries SET status = 'failed', next_attempt_at = unixepoch() + 60");
    expect(await listDueWebhookDeliveries(db, 10)).toEqual([]);
  });

  it("retries an exhausted delivery on request and lists deliveries newest first", async () => {
    const { subscription, deliveryId } = await deliveryFor();
    sqlite.exec(`UPDATE webhook_event_deliveries SET status = 'exhausted', attempts = ${WEBHOOK_MAX_ATTEMPTS}`);
    const retried = await retryWebhookDelivery(db, subscription.id, deliveryId);
    expect(retried).toMatchObject({ status: "pending", attempts: 0 });
    expect(await listDueWebhookDeliveries(db, 10)).toEqual([deliveryId]);
    await expect(retryWebhookDelivery(db, subscription.id, deliveryId)).rejects.toThrow(/Only failed/);
    const page = await listWebhookDeliveries(db, subscription.id, {});
    expect(page.deliveries.map((delivery) => delivery.id)).toEqual([deliveryId]);
    await expect(listWebhookDeliveries(db, "whs_missing", {})).rejects.toThrow(/not found/);
  });

  it("sends a one-shot signed test that never retries or touches endpoint health", async () => {
    const { subscription, secret } = await deliveryFor();
    let signed = false;
    const view = await sendWebhookTest(db, subscription.id, {
      encryptionKey: ENCRYPTION_KEY,
      fetch: async (_url, init) => {
        const headers = init.headers as Record<string, string>;
        signed = await verifyWebhookSignature({ secret, header: headers["Scalius-Signature"], body: init.body as string });
        expect(headers["Scalius-Topic"]).toBe("webhook.test");
        return new Response("nope", { status: 500 });
      },
    });
    expect(signed).toBe(true);
    expect(view).toMatchObject({ kind: "test", status: "failed", responseStatus: 500, maxAttempts: 1, nextAttemptAt: null });
    expect(sqlite.prepare("SELECT failure_streak FROM webhook_subscriptions").get()).toEqual({ failure_streak: 0 });
    expect(await listDueWebhookDeliveries(db, 10)).toHaveLength(1); // only the event delivery
  });

  it("prunes settled events and terminal deliveries past retention", async () => {
    await deliveryFor();
    sqlite.exec("UPDATE webhook_event_deliveries SET status = 'succeeded', created_at = created_at - 40 * 86400");
    sqlite.exec("UPDATE event_outbox SET dispatched_at = unixepoch() - 8 * 86400 WHERE status = 'dispatched'");
    const pruned = await pruneEventsAndDeliveries(db);
    expect(pruned.deliveries).toBe(1);
    expect(pruned.events).toBeGreaterThanOrEqual(1);
    expect(sqlite.prepare("SELECT count(*) AS n FROM webhook_event_deliveries").get()).toEqual({ n: 0 });
  });
});

describe("webhook subscriptions", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
  });
  afterEach(() => sqlite.close());

  it("stores only ciphertext, shows the secret once, and rotates it", async () => {
    const created = await createWebhookSubscription(db, {
      url: "https://hooks.example.com/a",
      topics: ["order.paid", "order.*", "customer.created"],
      description: "  ERP sync  ",
    }, { actorId: null, encryptionKey: ENCRYPTION_KEY });
    expect(created.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(created.subscription).toMatchObject({
      topics: ["order.*", "customer.created"],
      description: "ERP sync",
      secretHint: created.secret.slice(-4),
      status: "active",
      version: 1,
    });
    const stored = sqlite.prepare("SELECT secret_ciphertext FROM webhook_subscriptions").get() as { secret_ciphertext: string };
    expect(stored.secret_ciphertext.startsWith("enc:")).toBe(true);
    expect(stored.secret_ciphertext).not.toContain(created.secret);
    await expect(readWebhookSecret({ secretCiphertext: stored.secret_ciphertext }, ENCRYPTION_KEY)).resolves.toBe(created.secret);

    const rotated = await rotateWebhookSecret(db, created.subscription.id, { encryptionKey: ENCRYPTION_KEY });
    expect(rotated.secret).not.toBe(created.secret);
    expect(rotated.subscription.version).toBe(2);
  });

  it("refuses unsafe URLs, unknown topics, duplicates, stale versions and a missing key", async () => {
    const options = { actorId: null, encryptionKey: ENCRYPTION_KEY };
    await expect(createWebhookSubscription(db, { url: "http://hooks.example.com/a", topics: ["*"] }, options))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", details: { field: "url", issue: "not_https" } });
    await expect(createWebhookSubscription(db, { url: "https://169.254.169.254/", topics: ["*"] }, options))
      .rejects.toMatchObject({ details: { issue: "private_address" } });
    await expect(createWebhookSubscription(db, { url: "https://hooks.example.com/a", topics: ["order.shipped"] }, options))
      .rejects.toMatchObject({ details: { field: "topics" } });
    await expect(createWebhookSubscription(db, { url: "https://hooks.example.com/a", topics: ["*"] }, { actorId: null, encryptionKey: undefined }))
      .rejects.toMatchObject({ status: 503 });
    const { subscription } = await createWebhookSubscription(db, { url: "https://hooks.example.com/a", topics: ["*"] }, options);
    await expect(createWebhookSubscription(db, { url: "https://hooks.example.com/a", topics: ["*"] }, options))
      .rejects.toMatchObject({ status: 409 });
    await expect(updateWebhookSubscription(db, subscription.id, { expectedVersion: 9, description: "x" }))
      .rejects.toMatchObject({ code: "WEBHOOK_VERSION_CONFLICT", details: { expectedVersion: 9, currentVersion: 1 } });
    const disabled = await updateWebhookSubscription(db, subscription.id, { expectedVersion: 1, status: "disabled" });
    expect(disabled).toMatchObject({ status: "disabled", disabledReason: "manual", version: 2 });
    await deleteWebhookSubscription(db, subscription.id);
    await expect(deleteWebhookSubscription(db, subscription.id)).rejects.toMatchObject({ status: 404 });
  });

  it("masks contacts, credentials and long numbers in response excerpts", () => {
    expect(maskResponseExcerpt("Bearer abc.def ok, call +8801711111111, key sk_live_ABCDEFGHIJKLMNOPQRSTUVWX, mail a@b.co"))
      .toBe("Bearer [redacted] ok, call [number], key [redacted], mail [email]");
    expect(maskResponseExcerpt("x".repeat(1000))!.length).toBeLessThanOrEqual(256);
    expect(maskResponseExcerpt("whsec_secretvalue echoed", "whsec_secretvalue")).toBe("[secret] echoed");
    expect(maskResponseExcerpt("   ")).toBeNull();
  });
});
