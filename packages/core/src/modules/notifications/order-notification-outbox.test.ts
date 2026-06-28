import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import {
  claimOrderNotificationOutboxForProcessing,
  enqueueOrderNotificationOutboxById,
  listOrderNotificationOutboxForOrder,
  recordAndEnqueueOrderNotification,
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
  const project = (row: StoredOutboxRow, projection?: Record<string, unknown>) => {
    if (!projection) return { ...row };
    return Object.fromEntries(
      Object.keys(projection).map((key) => [key, row[key as keyof StoredOutboxRow]]),
    );
  };

  const applyUpdate = (values: Record<string, unknown>, returning: boolean) => {
    const row = firstRow();
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

    if ((values.status === "queued" || values.status === "sent" || values.status === "failed") && !row.claimId) {
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
          : row.nextAttemptAt,
      queuedAt: values.status === "queued" ? now : row.queuedAt,
      sentAt: values.status === "sent" ? now : row.sentAt,
      updatedAt: now,
    } as StoredOutboxRow;

    rows.set(row.id, next);
    return returning ? [project(next, { id: true, payload: true, claimId: true, attempts: true })] : [];
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
        const selectedRows = () => isReceiptQuery
          ? [...receipts.values()]
          : [...rows.values()].map((row) => project(row, projection));
        const thenableRows = (items: unknown[]) => ({
          all: async () => items,
          then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
            Promise.resolve(items).then(resolve, reject),
        });
        return {
        where: () => ({
          get: async () => {
            const row = firstRow();
            return row ? project(row, projection) : undefined;
          },
          orderBy: () => ({
            limit: (limit: number) => thenableRows(selectedRows().slice(0, limit)),
            then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
              Promise.resolve(selectedRows()).then(resolve, reject),
          }),
        }),
      };
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => applyUpdate(values, true),
          then: (resolve: (value: unknown[]) => void, reject: (reason?: unknown) => void) =>
            Promise.resolve(applyUpdate(values, false)).then(resolve, reject),
        }),
      }),
    }),
  } as unknown as Database;

  return { db, rows };
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
