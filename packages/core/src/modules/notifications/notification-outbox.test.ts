import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
  claimNotificationOutboxForProcessing,
  createNotificationOutboxInsertValues,
  flushPendingNotificationOutbox,
  markNotificationOutboxProcessingFailed,
  recordAndEnqueueNotification,
  sanitizeNotificationData,
  type NotificationQueueMessage,
} from "./notification-outbox";
import {
  createOrderNotificationOutboxInsertValues,
  listOrderNotificationOutboxForOrder,
  recordAndEnqueueOrderNotification,
  resendTerminalOrderNotificationOutboxById,
  retryFailedOrderNotificationOutboxById,
} from "./order-notification-outbox";
import { notificationOutbox } from "@scalius/database/schema";

const ORDER_ID = "ORDER_OUTBOX_01";

describe("generic notification outbox", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let sent: NotificationQueueMessage[];
  const queue = {
    send: vi.fn(async (message: NotificationQueueMessage) => { sent.push(message); }),
    sendBatch: vi.fn(async (messages: Iterable<{ body: NotificationQueueMessage }>) => {
      for (const message of messages) sent.push(message.body);
    }),
  };

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    sent = [];
    queue.send.mockClear();
    queue.sendBatch.mockClear();
    sqlite.exec(`INSERT INTO orders (id, customer_name, customer_phone, customer_email, shipping_address, city, zone,
        city_name, zone_name, total_amount_minor, subtotal_amount_minor, status)
      VALUES ('${ORDER_ID}', 'Rahim Uddin', '+8801711111111', 'rahim@example.test', 'House 1', 'city_1', 'zone_1',
        'Dhaka', 'Mirpur', 50000, 50000, 'confirmed')`);
  });

  afterEach(() => sqlite.close());

  const outboxRows = () => sqlite.prepare(
    "SELECT id, subject_type, subject_id, order_id, conversation_id, audience, notification_type, payload, status, attempts FROM notification_outbox ORDER BY created_at, id",
  ).all() as Array<Record<string, unknown>>;

  it("keeps the order wrapper signature and writes subject_type='order' rows (parity)", async () => {
    const result = await recordAndEnqueueOrderNotification({
      db,
      queue,
      notification: {
        dedupeKey: `order_created:${ORDER_ID}`,
        orderId: ORDER_ID,
        customerEmail: "rahim@example.test",
        customerName: "Rahim Uddin",
        notificationType: "order_created",
        source: "storefront-order",
      },
    });

    expect(result).toMatchObject({ created: true, enqueued: true, dedupeKey: `order_created:${ORDER_ID}` });
    const [row] = outboxRows();
    expect(row).toMatchObject({
      id: result.outboxId,
      subject_type: "order",
      subject_id: ORDER_ID,
      order_id: ORDER_ID,
      conversation_id: null,
      audience: "customer",
      notification_type: "order_created",
      status: "queued",
    });
    // C6: the queue carries only the outbox id; the row carries no contact.
    expect(sent).toEqual([{ type: "notification", outboxId: result.outboxId }]);
    expect(JSON.parse(String(row!.payload))).toEqual({ notificationType: "order_created" });
    expect(String(row!.payload)).not.toMatch(/rahim|@|\+880/i);
  });

  it("builds the same order row for callers that write it in their own batch", async () => {
    const values = createOrderNotificationOutboxInsertValues({
      dedupeKey: `order_created:${ORDER_ID}`,
      orderId: ORDER_ID,
      customerEmail: "rahim@example.test",
      customerName: "Rahim Uddin",
      notificationType: "order_created",
      source: "storefront-order",
    });
    await db.batch([db.insert(notificationOutbox).values(values)]);
    expect(outboxRows()[0]).toMatchObject({ subject_type: "order", order_id: ORDER_ID, status: "pending" });
    expect(String(values.payload)).not.toContain("rahim");
  });

  it("is idempotent by dedupe key and does not resend a sent duplicate", async () => {
    const input = { dedupeKey: "dup-1", orderId: ORDER_ID, notificationType: "order_confirmed" as const, source: "test" };
    const first = await recordAndEnqueueOrderNotification({ db, queue, notification: input });
    const claim = await claimNotificationOutboxForProcessing(db, first.outboxId);
    expect(claim.claimed).toBe(true);
    sqlite.exec(`UPDATE notification_outbox SET status = 'sent' WHERE id = '${first.outboxId}'`);

    const second = await recordAndEnqueueOrderNotification({ db, queue, notification: input });
    expect(second).toMatchObject({ outboxId: first.outboxId, created: false, enqueued: false, skippedReason: "already_sent" });
    expect(outboxRows()).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("marks a queue send failure retryable and the flush re-enqueues it when due", async () => {
    const failing = { send: vi.fn().mockRejectedValue(new Error("queue down")) };
    const result = await recordAndEnqueueOrderNotification({
      db,
      queue: failing,
      notification: { dedupeKey: "qfail", orderId: ORDER_ID, notificationType: "order_shipped", source: "test", data: { trackingId: "PX-1" } },
    });
    expect(result).toMatchObject({ enqueued: false, skippedReason: "queue_failed" });
    expect(outboxRows()[0]).toMatchObject({ status: "failed", attempts: 1 });

    sqlite.exec("UPDATE notification_outbox SET next_attempt_at = 0");
    const flushed = await flushPendingNotificationOutbox({ db, queue });
    expect(flushed).toMatchObject({ scanned: 1, enqueued: 1 });
    expect(sent).toEqual([{ type: "notification", outboxId: result.outboxId }]);
  });

  it("claims for processing with the subject and sanitized data, and backs off failures", async () => {
    const result = await recordAndEnqueueOrderNotification({
      db,
      queue,
      notification: { dedupeKey: "claim", orderId: ORDER_ID, notificationType: "order_shipped", source: "test", data: { trackingId: "PX-9" } },
    });
    const claim = await claimNotificationOutboxForProcessing(db, result.outboxId);
    expect(claim).toMatchObject({
      claimed: true,
      subjectType: "order",
      subjectId: ORDER_ID,
      audience: "customer",
      notificationType: "order_shipped",
      data: { trackingId: "PX-9" },
    });
    if (!claim.claimed) throw new Error("expected a claim");
    expect(await claimNotificationOutboxForProcessing(db, result.outboxId)).toEqual({ claimed: false, reason: "busy" });

    await markNotificationOutboxProcessingFailed(db, claim.outboxId, claim.claimId, claim.attempts, new Error("smtp 503"));
    expect(outboxRows()[0]).toMatchObject({ status: "failed" });
    // Not due yet: the backoff keeps it from being claimed early.
    expect(await claimNotificationOutboxForProcessing(db, result.outboxId)).toEqual({ claimed: false, reason: "busy" });
  });

  it("dead-letters a row after the automatic attempt cap", async () => {
    const result = await recordAndEnqueueOrderNotification({
      db,
      queue,
      notification: { dedupeKey: "cap", orderId: ORDER_ID, notificationType: "order_confirmed", source: "test" },
    });
    sqlite.exec(`UPDATE notification_outbox SET attempts = 7 WHERE id = '${result.outboxId}'`);
    const claim = await claimNotificationOutboxForProcessing(db, result.outboxId);
    if (!claim.claimed) throw new Error("expected a claim");
    await markNotificationOutboxProcessingFailed(db, claim.outboxId, claim.claimId, claim.attempts, new Error("still down"));
    const row = sqlite.prepare("SELECT status, last_error FROM notification_outbox").get() as Record<string, string>;
    expect(row.status).toBe("dead_lettered");
    expect(row.last_error).toMatch(/^notification_attempt_limit_reached/);
  });

  it("re-enqueues stale queued rows and leaves fresh queued rows alone", async () => {
    const result = await recordAndEnqueueOrderNotification({
      db,
      queue,
      notification: { dedupeKey: "stale", orderId: ORDER_ID, notificationType: "order_confirmed", source: "test" },
    });
    expect(await flushPendingNotificationOutbox({ db, queue })).toMatchObject({ scanned: 0 });
    sqlite.exec(`UPDATE notification_outbox SET queued_at = unixepoch() - 3601 WHERE id = '${result.outboxId}'`);
    const flushed = await flushPendingNotificationOutbox({ db, queue });
    expect(flushed).toMatchObject({ scanned: 1, enqueued: 1, staleQueued: 1 });
    expect(sent).toHaveLength(2);
  });

  it("flushes up to 200 due rows in claimed batches of at most 100 messages, ids only", async () => {
    await db.batch(Array.from({ length: 230 }, (_, index) => db.insert(notificationOutbox).values(
      createOrderNotificationOutboxInsertValues({
        dedupeKey: `bulk:${index}`,
        orderId: ORDER_ID,
        notificationType: "order_confirmed",
        source: "test",
      }),
    )) as never);
    // One row is held by a live consumer claim: the flush must not steal it.
    const held = String(outboxRows()[0]!.id);
    sqlite.exec(`UPDATE notification_outbox SET status = 'processing', claim_id = 'other', claim_expires_at = unixepoch() + 600 WHERE id = '${held}'`);

    const flushed = await flushPendingNotificationOutbox({ db, queue, limit: 500 });
    expect(flushed).toMatchObject({ scanned: 200, enqueued: 200, failed: 0, skipped: 0 });
    expect(queue.send).not.toHaveBeenCalled();
    expect(queue.sendBatch.mock.calls.length).toBeGreaterThan(1);
    for (const [messages] of queue.sendBatch.mock.calls) {
      expect([...messages].length).toBeLessThanOrEqual(100);
    }
    expect(sent).toHaveLength(200);
    expect(new Set(sent.map((message) => message.outboxId)).size).toBe(200);
    expect(sent.every((message) => Object.keys(message).sort().join() === "outboxId,type" && message.type === "notification")).toBe(true);
    expect(sent.some((message) => message.outboxId === held)).toBe(false);

    const statuses = sqlite.prepare("SELECT status, count(*) AS n FROM notification_outbox GROUP BY status ORDER BY status").all();
    expect(statuses).toEqual([
      { status: "pending", n: 29 },
      { status: "processing", n: 1 },
      { status: "queued", n: 200 },
    ]);
    // A second run takes the rest; queued rows are not sent again.
    expect(await flushPendingNotificationOutbox({ db, queue, limit: 200 })).toMatchObject({ scanned: 29, enqueued: 29 });
    expect(sent).toHaveLength(229);
  });

  it("marks a whole failed batch retryable with backoff", async () => {
    const recorded = await recordAndEnqueueNotification({
      db,
      queue: undefined,
      notification: { subjectType: "order", subjectId: ORDER_ID, audience: "customer", notificationType: "order_confirmed", dedupeKey: "batch-fail", source: "test" },
    });
    const failing = { send: vi.fn(), sendBatch: vi.fn().mockRejectedValue(new Error("queue down")) };
    expect(await flushPendingNotificationOutbox({ db, queue: failing })).toMatchObject({ scanned: 1, enqueued: 0, failed: 1 });
    const row = sqlite.prepare("SELECT status, attempts, next_attempt_at > unixepoch() AS later, claim_id FROM notification_outbox WHERE id = ?")
      .get(recorded.outboxId);
    expect(row).toEqual({ status: "failed", attempts: 1, later: 1, claim_id: null });
  });

  it("keeps a notBefore row scheduled until it is due", async () => {
    const notBefore = Math.floor(Date.now() / 1000) + 7 * 86_400;
    const result = await recordAndEnqueueNotification({
      db,
      queue,
      notification: {
        subjectType: "order",
        subjectId: ORDER_ID,
        audience: "customer",
        notificationType: "review_request",
        dedupeKey: `order:${ORDER_ID}:review_request`,
        source: "test",
        notBefore,
      },
    });
    expect(result).toMatchObject({ created: true, enqueued: false, scheduledFor: notBefore });
    expect(result.skippedReason).toBeUndefined();
    expect(sqlite.prepare("SELECT status, next_attempt_at FROM notification_outbox").get())
      .toEqual({ status: "pending", next_attempt_at: notBefore });
    expect(sent).toHaveLength(0);
    expect(await flushPendingNotificationOutbox({ db, queue })).toMatchObject({ scanned: 0 });
    expect(await claimNotificationOutboxForProcessing(db, result.outboxId)).toEqual({ claimed: false, reason: "busy" });

    // Its day comes.
    sqlite.exec("UPDATE notification_outbox SET next_attempt_at = unixepoch() - 1");
    expect(await flushPendingNotificationOutbox({ db, queue })).toMatchObject({ scanned: 1, enqueued: 1 });
    expect(sent).toEqual([{ type: "notification", outboxId: result.outboxId }]);

    // A past or absent notBefore is due at once.
    const now = createNotificationOutboxInsertValues({
      subjectType: "order", subjectId: ORDER_ID, audience: "customer", notificationType: "order_confirmed",
      dedupeKey: "past", source: "test", notBefore: 1,
    });
    expect(Number(now.nextAttemptAt)).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });

  it("lists, retries and manually resends order rows with their receipts", async () => {
    const result = await recordAndEnqueueOrderNotification({
      db,
      queue,
      notification: { dedupeKey: "list", orderId: ORDER_ID, notificationType: "order_confirmed", source: "test" },
    });
    sqlite.exec(`
      UPDATE notification_outbox SET status = 'failed', next_attempt_at = unixepoch() + 999 WHERE id = '${result.outboxId}';
      INSERT INTO notification_delivery_receipts (id, receipt_key, outbox_id, subject_type, subject_id, order_id, notification_type,
        channel, provider, recipient_hash, status, next_attempt_at)
      VALUES ('rcpt_1', 'rk_1', '${result.outboxId}', 'order', '${ORDER_ID}', '${ORDER_ID}', 'order_confirmed', 'email', 'email', 'hash',
        'failed', unixepoch() + 999);`);

    const listed = await listOrderNotificationOutboxForOrder(db, ORDER_ID);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: result.outboxId, orderId: ORDER_ID, status: "failed", receipts: [{ id: "rcpt_1", status: "failed" }] });

    const retried = await retryFailedOrderNotificationOutboxById({ db, queue, orderId: ORDER_ID, outboxId: result.outboxId });
    expect(retried).toMatchObject({ enqueued: true });
    const receipt = sqlite.prepare("SELECT next_attempt_at <= unixepoch() AS due FROM notification_delivery_receipts").get() as { due: number };
    expect(receipt.due).toBe(1);

    expect(await retryFailedOrderNotificationOutboxById({ db, queue, orderId: "OTHER", outboxId: result.outboxId }))
      .toMatchObject({ skippedReason: "missing" });
    expect(await resendTerminalOrderNotificationOutboxById({ db, queue, orderId: ORDER_ID, outboxId: result.outboxId, resendRequestId: "r1" }))
      .toMatchObject({ skippedReason: "not_sent" });

    sqlite.exec(`UPDATE notification_outbox SET status = 'sent' WHERE id = '${result.outboxId}'`);
    expect(await retryFailedOrderNotificationOutboxById({ db, queue, orderId: ORDER_ID, outboxId: result.outboxId }))
      .toMatchObject({ skippedReason: "already_sent" });

    const resend = await resendTerminalOrderNotificationOutboxById({ db, queue, orderId: ORDER_ID, outboxId: result.outboxId, resendRequestId: "r1" });
    expect(resend).toMatchObject({ created: true, enqueued: true, dedupeKey: `manual_resend:${result.outboxId}:r1` });
    const again = await resendTerminalOrderNotificationOutboxById({ db, queue, orderId: ORDER_ID, outboxId: result.outboxId, resendRequestId: "r1" });
    expect(again).toMatchObject({ outboxId: resend.outboxId, created: false });
    expect(outboxRows().filter((row) => row.subject_type === "order")).toHaveLength(2);
  });

  it("C6: payload data keeps only short id-shaped facts, never contacts, bodies or codes", () => {
    expect(sanitizeNotificationData({
      trackingId: "PX-1",
      amount: 120,
      supportRequestType: "return",
      customerEmail: "a@b.test",
      customerPhone: "+8801711111111",
      customerName: "Rahim",
      body: "Here is my bKash screenshot",
      message: "hello",
      code: "123456",
      token: "chk_secret",
      seq: 3,
      nested: { email: "x" },
      long: "x".repeat(500),
    })).toEqual({ trackingId: "PX-1", amount: 120, supportRequestType: "return", seq: 3 });

    const values = createNotificationOutboxInsertValues({
      subjectType: "conversation",
      subjectId: "cnv_abcdefgh12",
      audience: "staff",
      notificationType: "conversation_message",
      dedupeKey: "conversation:cnv_abcdefgh12:staff:1",
      source: "test",
      data: { seq: 1, body: "private text" },
    });
    expect(values).toMatchObject({ subjectType: "conversation", conversationId: "cnv_abcdefgh12", orderId: null });
    expect(JSON.parse(String(values.payload))).toEqual({ notificationType: "conversation_message", data: { seq: 1 } });
  });

  it("rejects conversation rows whose conversation_id is not the subject", async () => {
    await expect(recordAndEnqueueNotification({
      db,
      queue,
      notification: {
        subjectType: "conversation",
        subjectId: "cnv_missing_thread",
        audience: "staff",
        notificationType: "conversation_message",
        dedupeKey: "conversation:cnv_missing_thread:staff:1",
        source: "test",
      },
    })).rejects.toThrow();
    expect(outboxRows()).toHaveLength(0);
  });
});
