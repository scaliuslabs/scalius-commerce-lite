import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import {
  claimOrderNotificationOutboxForProcessing,
  recordAndEnqueueOrderNotification,
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

const now = 1_000;

function createOutboxDb(initialRows: StoredOutboxRow[] = []) {
  const rows = new Map(initialRows.map((row) => [row.id, { ...row }]));

  const firstRow = () => [...rows.values()][0];
  const project = (row: StoredOutboxRow, projection?: Record<string, unknown>) => {
    if (!projection) return { ...row };
    if ("id" in projection && Object.keys(projection).length === 1) return { id: row.id };
    return {
      id: row.id,
      payload: row.payload,
      claimId: row.claimId,
      attempts: row.attempts,
    };
  };

  const applyUpdate = (values: Record<string, unknown>, returning: boolean) => {
    const row = firstRow();
    if (!row) return [];

    if (values.status === "enqueueing") {
      const due = row.nextAttemptAt <= now;
      const staleClaim = row.claimExpiresAt != null && row.claimExpiresAt <= now;
      if (!((["pending", "failed"].includes(row.status) && due) || (["enqueueing", "processing"].includes(row.status) && staleClaim))) {
        return [];
      }
    }

    if (values.status === "processing") {
      const staleProcessing = row.status === "processing" && row.claimExpiresAt != null && row.claimExpiresAt <= now;
      if (!(["pending", "failed", "enqueueing", "queued"].includes(row.status) || staleProcessing)) {
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
      nextAttemptAt: values.status === "failed" ? now + 60 : row.nextAttemptAt,
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
      from: () => ({
        where: () => ({
          get: async () => {
            const row = firstRow();
            return row ? project(row, projection) : undefined;
          },
          orderBy: () => ({
            limit: (limit: number) => ({
              all: async () => [...rows.values()].slice(0, limit).map((row) => project(row, projection)),
            }),
          }),
        }),
      }),
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
});
