import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { orderNotificationDeliveryReceipts } from "@scalius/database/schema";
import {
  claimOrderNotificationOutboxForProcessing,
  enqueueOrderNotificationOutboxById,
  listOrderNotificationOutboxForOrder,
  markOrderNotificationOutboxProcessingFailed,
  recordAndEnqueueOrderNotification,
  resendTerminalOrderNotificationOutboxById,
  retryFailedOrderNotificationOutboxById,
  flushPendingOrderNotificationOutbox,
  STALE_QUEUED_REPLAY_SECONDS,
} from "./order-notification-outbox";

interface StoredOutboxRow {
  id: string;
  dedupeKey: string;
  orderId: string;
  notificationType: string;
  source: string;
  payload: string;
  status: string;
  attempts: number;
  nextAttemptAt: number;
  claimId: string | null;
  claimExpiresAt: number | null;
  lastError: string | null;
  queuedAt: number | null;
  sentAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface StoredReceiptRow {
  id: string;
  receiptKey: string;
  outboxId: string;
  orderId: string;
  notificationType: string;
  channel: string;
  provider: string;
  recipientHash: string;
  recipientMasked: string | null;
  status: string;
  providerMessageId: string | null;
  providerStatus: string | null;
  rawResponse: string | null;
  attempts: number;
  nextAttemptAt: number;
  claimId: string | null;
  claimExpiresAt: number | null;
  lastError: string | null;
  lastAttemptAt: number | null;
  acceptedAt: number | null;
  deliveredAt: number | null;
  failedAt: number | null;
  skippedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

const now = 1_000;

function createOutboxDb(initialRows: StoredOutboxRow[] = [], initialReceipts: StoredReceiptRow[] = []) {
  const rows = new Map(initialRows.map((row) => [row.id, { ...row }]));
  const receipts = new Map(initialReceipts.map((row) => [row.id, { ...row }]));

  const firstRow = () => [...rows.values()][0];
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;
  const findPredicateValue = (predicate: unknown, columnName: string): string | undefined => {
    if (!isObject(predicate) || !Array.isArray(predicate.queryChunks)) return undefined;

    for (let index = 0; index < predicate.queryChunks.length; index += 1) {
      const chunk = predicate.queryChunks[index];
      if (isObject(chunk) && chunk.name === columnName) {
        for (const candidate of predicate.queryChunks.slice(index + 1)) {
          if (!isObject(candidate)) continue;
          if (Array.isArray(candidate.queryChunks)) break;
          if ("value" in candidate && !Array.isArray(candidate.value) && candidate.value != null) {
            return String(candidate.value);
          }
        }
      }

      const nested = findPredicateValue(chunk, columnName);
      if (nested) return nested;
    }

    return undefined;
  };
  const findOutboxRow = (predicate?: unknown) => {
    const id = findPredicateValue(predicate, "id");
    if (id) return rows.get(id);

    const dedupeKey = findPredicateValue(predicate, "dedupe_key");
    if (dedupeKey) return [...rows.values()].find((row) => row.dedupeKey === dedupeKey);

    const orderId = findPredicateValue(predicate, "order_id");
    if (orderId) return [...rows.values()].find((row) => row.orderId === orderId);

    return firstRow();
  };
  const filterOutboxRows = (predicate?: unknown) => {
    const id = findPredicateValue(predicate, "id");
    if (id) return [...rows.values()].filter((row) => row.id === id);

    const dedupeKey = findPredicateValue(predicate, "dedupe_key");
    if (dedupeKey) return [...rows.values()].filter((row) => row.dedupeKey === dedupeKey);

    const orderId = findPredicateValue(predicate, "order_id");
    if (orderId) return [...rows.values()].filter((row) => row.orderId === orderId);

    return [...rows.values()];
  };
  const project = (row: StoredOutboxRow, projection?: Record<string, unknown>) => {
    if (!projection) return { ...row };
    return Object.fromEntries(
      Object.keys(projection).map((key) => [key, row[key as keyof StoredOutboxRow]]),
    );
  };

  const applyOutboxUpdate = (values: Record<string, unknown>, returning: boolean, predicate?: unknown) => {
    const row = findOutboxRow(predicate);
    if (!row) return [];

    if (values.status === "enqueueing") {
      const due = row.nextAttemptAt <= now;
      const staleClaim = row.claimExpiresAt != null && row.claimExpiresAt <= now;
      const staleQueued = row.status === "queued" && row.queuedAt != null && row.queuedAt <= now - STALE_QUEUED_REPLAY_SECONDS;
      if (!((["pending", "failed"].includes(row.status) && due) || (["enqueueing", "processing"].includes(row.status) && staleClaim) || staleQueued)) {
        return [];
      }
    }

    if (values.status === "processing") {
      const staleProcessing = row.status === "processing" && row.claimExpiresAt != null && row.claimExpiresAt <= now;
      const duePendingOrFailed = ["pending", "failed"].includes(row.status) && row.nextAttemptAt <= now;
      const queued = row.status === "queued";
      const staleEnqueueing = row.status === "enqueueing" && row.claimExpiresAt != null && row.claimExpiresAt <= now;
      if (!(duePendingOrFailed || queued || staleEnqueueing || staleProcessing)) {
        return [];
      }
    }

    if ((values.status === "queued" || values.status === "sent" || values.status === "failed" || values.status === "dead_lettered") && !row.claimId) {
      return [];
    }

    const next: StoredOutboxRow = {
      ...row,
      ...values,
      attempts: values.attempts == null ? row.attempts : row.attempts + 1,
      claimExpiresAt: values.status === "enqueueing"
        ? now + 300
        : values.status === "processing"
          ? now + 900
          : values.claimExpiresAt === null
            ? null
            : row.claimExpiresAt,
      nextAttemptAt: values.status === "failed"
        ? now + 60
        : values.status === "pending"
          ? now
          : typeof values.nextAttemptAt === "number"
            ? values.nextAttemptAt
            : row.nextAttemptAt,
      queuedAt: values.status === "queued" ? now : row.queuedAt,
      sentAt: values.status === "sent" ? now : row.sentAt,
      updatedAt: now,
    } as StoredOutboxRow;

    rows.set(row.id, next);
    return returning ? [project(next, { id: true, payload: true, claimId: true, attempts: true })] : [];
  };

  const applyReceiptUpdate = (values: Record<string, unknown>, returning: boolean, predicate?: unknown) => {
    const updated: StoredReceiptRow[] = [];
    const outboxId = findPredicateValue(predicate, "outbox_id") ?? "outbox_1";
    for (const receipt of receipts.values()) {
      if (receipt.outboxId !== outboxId) continue;
      if (!["pending", "failed"].includes(receipt.status)) continue;
      const next: StoredReceiptRow = {
        ...receipt,
        nextAttemptAt: values.nextAttemptAt == null ? receipt.nextAttemptAt : now,
        claimId: values.claimId === null ? null : receipt.claimId,
        claimExpiresAt: values.claimExpiresAt === null ? null : receipt.claimExpiresAt,
        updatedAt: now,
      };
      receipts.set(receipt.id, next);
      updated.push(next);
    }
    return returning ? updated.map((row) => ({ id: row.id })) : [];
  };

  const db = {
    insert: () => ({
      values: async (values: StoredOutboxRow) => {
        if ([...rows.values()].some((row) => row.dedupeKey === values.dedupeKey)) {
          throw new Error("duplicate dedupe key");
        }
        rows.set(values.id, {
          ...values,
          nextAttemptAt: now,
          claimId: null,
          claimExpiresAt: null,
          lastError: null,
          queuedAt: null,
          sentAt: null,
          createdAt: now,
          updatedAt: now,
        });
      },
    }),
    select: (projection?: Record<string, unknown>) => ({
      from: () => {
        const keys = projection ? Object.keys(projection) : [];
        const isReceiptQuery = keys.includes("receiptKey");
        const selectedRows = (predicate?: unknown) => isReceiptQuery
          ? [...receipts.values()]
          : filterOutboxRows(predicate).map((row) => project(row, projection));
        const thenableRows = (items: unknown[]) => ({
          all: async () => items,
          then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
            Promise.resolve(items).then(resolve, reject),
        });
        return {
        where: (predicate?: unknown) => ({
          get: async () => {
            const row = findOutboxRow(predicate);
            return row ? project(row, projection) : undefined;
          },
          orderBy: () => ({
            limit: (limit: number) => thenableRows(selectedRows(predicate).slice(0, limit)),
            then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
              Promise.resolve(selectedRows(predicate)).then(resolve, reject),
          }),
        }),
      };
      },
    }),
    update: (table?: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: (predicate?: unknown) => ({
          returning: async () => table === orderNotificationDeliveryReceipts
            ? applyReceiptUpdate(values, true, predicate)
            : applyOutboxUpdate(values, true, predicate),
          then: (resolve: (value: unknown[]) => void, reject: (reason?: unknown) => void) =>
            Promise.resolve(table === orderNotificationDeliveryReceipts
              ? applyReceiptUpdate(values, false, predicate)
              : applyOutboxUpdate(values, false, predicate)).then(resolve, reject),
        }),
      }),
    }),
  } as unknown as Database;

  return { db, rows, receipts };
}

function createRow(overrides: Partial<StoredOutboxRow> = {}): StoredOutboxRow {
  return {
    id: "outbox_1",
    dedupeKey: "order_created:order_1",
    orderId: "order_1",
    notificationType: "order_created",
    source: "test",
    payload: JSON.stringify({
      type: "order.notification",
      orderId: "order_1",
      customerName: "Buyer",
      notificationType: "order_created",
    }),
    status: "pending",
    attempts: 0,
    nextAttemptAt: now,
    claimId: null,
    claimExpiresAt: null,
    lastError: null,
    queuedAt: null,
    sentAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createReceipt(overrides: Partial<StoredReceiptRow> = {}): StoredReceiptRow {
  return {
    id: "receipt_1",
    receiptKey: "outbox_1:email:recipient_hash",
    outboxId: "outbox_1",
    orderId: "order_1",
    notificationType: "order_created",
    channel: "email",
    provider: "cloudflare",
    recipientHash: "recipient_hash",
    recipientMasked: "b***@example.com",
    status: "failed",
    providerMessageId: null,
    providerStatus: "temporary_error",
    rawResponse: null,
    attempts: 2,
    nextAttemptAt: now + 60,
    claimId: null,
    claimExpiresAt: null,
    lastError: "provider timeout",
    lastAttemptAt: now,
    acceptedAt: null,
    deliveredAt: null,
    failedAt: now,
    skippedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("order notification outbox", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("records, claims, sends, and marks notifications queued", async () => {
    const { db, rows } = createOutboxDb();
    const queue = { send: vi.fn(async () => undefined) };

    const result = await recordAndEnqueueOrderNotification({
      db,
      queue,
      notification: {
        dedupeKey: "order_created:order_1",
        orderId: "order_1",
        customerEmail: "buyer@example.com",
        customerName: "Buyer",
        notificationType: "order_created",
        source: "test",
      },
    });

    expect(result).toMatchObject({ created: true, enqueued: true });
    expect(queue.send).toHaveBeenCalledWith(expect.objectContaining({
      outboxId: result.outboxId,
      orderId: "order_1",
      notificationType: "order_created",
    }));
    expect(rows.get(result.outboxId)).toMatchObject({
      status: "queued",
      attempts: 1,
      claimId: null,
      queuedAt: now,
    });
  });

  it("does not resend an already-sent duplicate", async () => {
    const existing = createRow({ status: "sent", sentAt: now });
    const { db } = createOutboxDb([existing]);
    const queue = { send: vi.fn(async () => undefined) };

    const result = await recordAndEnqueueOrderNotification({
      db,
      queue,
      notification: {
        dedupeKey: existing.dedupeKey,
        orderId: existing.orderId,
        customerName: "Buyer",
        notificationType: "order_created",
        source: "duplicate",
      },
    });

    expect(result).toMatchObject({
      created: false,
      enqueued: false,
      skippedReason: "already_sent",
    });
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("marks queue send failures retryable", async () => {
    const { db, rows } = createOutboxDb();
    const queue = { send: vi.fn(async () => { throw new Error("queue down"); }) };

    const result = await recordAndEnqueueOrderNotification({
      db,
      queue,
      notification: {
        dedupeKey: "order_created:order_1",
        orderId: "order_1",
        customerName: "Buyer",
        notificationType: "order_created",
        source: "test",
      },
    });

    expect(result).toMatchObject({ enqueued: false, skippedReason: "queue_failed" });
    expect(rows.get(result.outboxId)).toMatchObject({
      status: "failed",
      attempts: 1,
      claimId: null,
      lastError: "queue down",
      nextAttemptAt: now + 60,
    });
  });

  it("skips processing claims for already-sent rows", async () => {
    const { db } = createOutboxDb([createRow({ status: "sent", sentAt: now })]);

    const result = await claimOrderNotificationOutboxForProcessing(db, "outbox_1");

    expect(result).toEqual({ claimed: false, reason: "already_sent" });
  });

  it("does not process failed rows before their outbox retry time", async () => {
    const { db, rows } = createOutboxDb([createRow({
      status: "failed",
      attempts: 5,
      nextAttemptAt: now + 3_600,
      lastError: "provider auth failed",
    })]);

    const result = await claimOrderNotificationOutboxForProcessing(db, "outbox_1");

    expect(result).toEqual({ claimed: false, reason: "busy" });
    expect(rows.get("outbox_1")).toMatchObject({
      status: "failed",
      attempts: 5,
      nextAttemptAt: now + 3_600,
      lastError: "provider auth failed",
    });
  });

  it("processes fresh queued rows immediately", async () => {
    const { db, rows } = createOutboxDb([createRow({
      status: "queued",
      attempts: 1,
      queuedAt: now,
    })]);

    const result = await claimOrderNotificationOutboxForProcessing(db, "outbox_1");

    expect(result).toMatchObject({
      claimed: true,
      outboxId: "outbox_1",
    });
    expect(rows.get("outbox_1")).toMatchObject({
      status: "processing",
      attempts: 2,
    });
  });

  it("lists outbox rows with delivery receipt state for an order", async () => {
    const { db } = createOutboxDb(
      [createRow({ status: "failed", lastError: "delivery failed" })],
      [createReceipt()],
    );

    const result = await listOrderNotificationOutboxForOrder(db, "order_1");

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "outbox_1",
      orderId: "order_1",
      notificationType: "order_created",
      status: "failed",
      lastError: "delivery failed",
      receipts: [{
        id: "receipt_1",
        channel: "email",
        provider: "cloudflare",
        status: "failed",
        lastError: "provider timeout",
      }],
    });
  });

  it("retries failed outbox rows through the existing enqueue path", async () => {
    const { db, rows } = createOutboxDb([createRow({
      status: "failed",
      attempts: 2,
      lastError: "delivery failed",
      nextAttemptAt: now + 3_600,
    })]);
    const queue = { send: vi.fn(async () => undefined) };

    const result = await retryFailedOrderNotificationOutboxById({
      db,
      queue,
      orderId: "order_1",
      outboxId: "outbox_1",
    });

    expect(result).toMatchObject({
      outboxId: "outbox_1",
      dedupeKey: "order_created:order_1",
      created: false,
      enqueued: true,
    });
    expect(queue.send).toHaveBeenCalledWith(expect.objectContaining({
      outboxId: "outbox_1",
      orderId: "order_1",
      notificationType: "order_created",
    }));
    expect(rows.get("outbox_1")).toMatchObject({
      status: "queued",
      lastError: null,
      claimId: null,
    });
  });

  it("makes retryable child receipts due when manually retrying a failed outbox", async () => {
    const { db, receipts } = createOutboxDb(
      [createRow({
        status: "failed",
        attempts: 2,
        lastError: "delivery failed",
        nextAttemptAt: now + 3_600,
      })],
      [createReceipt({
        status: "failed",
        attempts: 3,
        nextAttemptAt: now + 3_600,
        claimId: "stale-claim",
        claimExpiresAt: now + 600,
      })],
    );
    const queue = { send: vi.fn(async () => undefined) };

    const result = await retryFailedOrderNotificationOutboxById({
      db,
      queue,
      orderId: "order_1",
      outboxId: "outbox_1",
    });

    expect(result.enqueued).toBe(true);
    expect(receipts.get("receipt_1")).toMatchObject({
      status: "failed",
      attempts: 3,
      nextAttemptAt: now,
      claimId: null,
      claimExpiresAt: null,
    });
  });

  it("dead-letters parent outbox rows after the automatic attempt cap", async () => {
    const { db, rows } = createOutboxDb([createRow({
      status: "processing",
      attempts: 8,
      claimId: "claim_1",
      claimExpiresAt: now + 600,
      lastError: null,
    })]);

    await markOrderNotificationOutboxProcessingFailed(
      db,
      "outbox_1",
      "claim_1",
      8,
      new Error("provider still down"),
    );

    expect(rows.get("outbox_1")).toMatchObject({
      status: "dead_lettered",
      claimId: null,
      claimExpiresAt: null,
      lastError: "order_notification_attempt_limit_reached: provider still down",
      nextAttemptAt: 253_402_300_799,
    });
  });

  it("does not retry sent outbox rows", async () => {
    const { db } = createOutboxDb([createRow({ status: "sent", sentAt: now })]);
    const queue = { send: vi.fn(async () => undefined) };

    const result = await retryFailedOrderNotificationOutboxById({
      db,
      queue,
      orderId: "order_1",
      outboxId: "outbox_1",
    });

    expect(result).toMatchObject({
      enqueued: false,
      skippedReason: "already_sent",
    });
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("creates and enqueues a fresh manual resend row for sent outbox rows", async () => {
    const { db, rows } = createOutboxDb([createRow({
      status: "sent",
      sentAt: now,
      payload: JSON.stringify({
        type: "order.notification",
        orderId: "order_1",
        customerEmail: "buyer@example.com",
        customerName: "Buyer",
        notificationType: "order_created",
        data: { total: 1250 },
      }),
    })]);
    const queue = { send: vi.fn(async () => undefined) };

    const result = await resendTerminalOrderNotificationOutboxById({
      db,
      queue,
      orderId: "order_1",
      outboxId: "outbox_1",
      resendRequestId: "manual_req_1",
    });

    expect(result).toMatchObject({
      dedupeKey: "manual_resend:outbox_1:manual_req_1",
      created: true,
      enqueued: true,
    });
    expect(result.outboxId).not.toBe("outbox_1");
    expect(queue.send).toHaveBeenCalledWith(expect.objectContaining({
      outboxId: result.outboxId,
      orderId: "order_1",
      customerEmail: "buyer@example.com",
      notificationType: "order_created",
      data: { total: 1250 },
    }));
    expect(rows.get(result.outboxId)).toMatchObject({
      dedupeKey: "manual_resend:outbox_1:manual_req_1",
      orderId: "order_1",
      source: "manual_resend",
      status: "queued",
      attempts: 1,
      claimId: null,
    });
    expect(rows.get("outbox_1")).toMatchObject({
      status: "sent",
      attempts: 0,
    });
  });

  it("keeps duplicate manual resend requests idempotent by resend request id", async () => {
    const { db, rows } = createOutboxDb([createRow({ status: "sent", sentAt: now })]);
    const queue = { send: vi.fn(async () => undefined) };

    const first = await resendTerminalOrderNotificationOutboxById({
      db,
      queue,
      orderId: "order_1",
      outboxId: "outbox_1",
      resendRequestId: "manual_req_1",
    });
    const second = await resendTerminalOrderNotificationOutboxById({
      db,
      queue,
      orderId: "order_1",
      outboxId: "outbox_1",
      resendRequestId: "manual_req_1",
    });

    expect(first).toMatchObject({ created: true, enqueued: true });
    expect(second).toMatchObject({
      outboxId: first.outboxId,
      dedupeKey: "manual_resend:outbox_1:manual_req_1",
      created: false,
      enqueued: false,
      skippedReason: "already_queued",
    });
    expect(rows.size).toBe(2);
    expect(queue.send).toHaveBeenCalledTimes(1);
  });

  it("does not manually resend non-sent rows", async () => {
    const { db, rows } = createOutboxDb([createRow({
      status: "failed",
      attempts: 2,
      lastError: "delivery failed",
    })]);
    const queue = { send: vi.fn(async () => undefined) };

    const result = await resendTerminalOrderNotificationOutboxById({
      db,
      queue,
      orderId: "order_1",
      outboxId: "outbox_1",
      resendRequestId: "manual_req_1",
    });

    expect(result).toMatchObject({
      outboxId: "outbox_1",
      dedupeKey: "order_created:order_1",
      created: false,
      enqueued: false,
      skippedReason: "already_retryable",
    });
    expect(rows.size).toBe(1);
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("re-enqueues stale queued rows through the normal enqueue claim", async () => {
    const { db, rows } = createOutboxDb([createRow({
      status: "queued",
      attempts: 1,
      queuedAt: now - STALE_QUEUED_REPLAY_SECONDS - 1,
    })]);
    const queue = { send: vi.fn(async () => undefined) };

    const result = await enqueueOrderNotificationOutboxById({
      db,
      queue,
      outboxId: "outbox_1",
    });

    expect(result).toMatchObject({
      outboxId: "outbox_1",
      enqueued: true,
    });
    expect(queue.send).toHaveBeenCalledWith(expect.objectContaining({
      outboxId: "outbox_1",
      orderId: "order_1",
    }));
    expect(rows.get("outbox_1")).toMatchObject({
      status: "queued",
      attempts: 2,
      claimId: null,
      lastError: null,
      queuedAt: now,
    });
  });

  it("does not re-enqueue fresh queued rows", async () => {
    const { db } = createOutboxDb([createRow({
      status: "queued",
      attempts: 1,
      queuedAt: now - STALE_QUEUED_REPLAY_SECONDS + 1,
    })]);
    const queue = { send: vi.fn(async () => undefined) };

    const result = await enqueueOrderNotificationOutboxById({
      db,
      queue,
      outboxId: "outbox_1",
    });

    expect(result).toMatchObject({
      outboxId: "outbox_1",
      enqueued: false,
      skippedReason: "already_queued",
    });
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("reports stale queued rows during scheduled outbox flushing", async () => {
    const { db } = createOutboxDb([createRow({
      status: "queued",
      attempts: 1,
      queuedAt: now - STALE_QUEUED_REPLAY_SECONDS - 1,
    })]);
    const queue = { send: vi.fn(async () => undefined) };

    const result = await flushPendingOrderNotificationOutbox({
      db,
      queue,
      limit: 10,
    });

    expect(result).toEqual({
      scanned: 1,
      enqueued: 1,
      failed: 0,
      skipped: 0,
      staleQueued: 1,
    });
  });
});
