import { describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import {
  DEFAULT_WEBHOOK_PROCESSING_LEASE_SECONDS,
  claimWebhookEvent,
} from "./webhook-idempotency";

interface StoredWebhookEvent {
  id: string;
  provider: string;
  eventType: string;
  orderId: string | null;
  status: string;
  result: string | null;
  processedAt: number;
}

function createWebhookDb(
  initialRows: StoredWebhookEvent[] = [],
  now = 1_000,
  options: { forceInsertError?: boolean } = {},
): { db: Database; rows: Map<string, StoredWebhookEvent> } {
  const rows = new Map(initialRows.map((row) => [row.id, { ...row }]));

  const normalize = (values: Record<string, unknown>) => ({
    ...values,
    result: values.result === undefined ? null : values.result,
    processedAt: values.processedAt === undefined ? now : now,
  });

  const applyUpdate = (values: Record<string, unknown>, returning: boolean) => {
    const firstRow = [...rows.values()][0];
    if (!firstRow) return [];

    if (returning) {
      const staleCutoff = now - DEFAULT_WEBHOOK_PROCESSING_LEASE_SECONDS;
      const reclaimableFailed = firstRow.status === "failed";
      const reclaimableProcessing = firstRow.status === "processing" && firstRow.processedAt <= staleCutoff;
      if (!reclaimableFailed && !reclaimableProcessing) {
        return [];
      }
    }

    rows.set(firstRow.id, {
      ...firstRow,
      ...normalize(values),
    } as StoredWebhookEvent);

    return returning ? [{ id: firstRow.id }] : [];
  };

  const db = {
    insert: () => ({
      values: async (values: StoredWebhookEvent) => {
        if (options.forceInsertError) throw new Error("temporary insert failure");
        if (rows.has(values.id)) throw new Error("duplicate webhook event");
        rows.set(values.id, {
          ...values,
          result: values.result ?? null,
          processedAt: now,
        });
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          get: async () => [...rows.values()][0] ?? null,
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          then: (resolve: (value: unknown[]) => void, reject: (reason?: unknown) => void) =>
            Promise.resolve(applyUpdate(values, false)).then(resolve, reject),
          returning: async () => applyUpdate(values, true),
        }),
      }),
    }),
  } as unknown as Database;

  return { db, rows };
}

const baseClaim = {
  id: "stripe:payment_intent-succeeded:evt_1",
  provider: "stripe",
  eventType: "payment_intent.succeeded",
  orderId: "order_1",
  status: "processing" as const,
};

describe("webhook idempotency claims", () => {
  it("claims a new event as processing", async () => {
    const { db, rows } = createWebhookDb();

    const result = await claimWebhookEvent(db, baseClaim);

    expect(result).toEqual({ claimed: true });
    expect(rows.get(baseClaim.id)).toMatchObject({
      provider: "stripe",
      eventType: "payment_intent.succeeded",
      orderId: "order_1",
      status: "processing",
      processedAt: 1_000,
    });
  });

  it("reclaims failed events immediately", async () => {
    const { db, rows } = createWebhookDb([
      {
        id: baseClaim.id,
        provider: "stripe",
        eventType: "payment_intent.succeeded",
        orderId: "old_order",
        status: "failed",
        result: "queue down",
        processedAt: 990,
      },
    ]);

    const result = await claimWebhookEvent(db, {
      ...baseClaim,
      orderId: "order_1",
      result: { retry: true },
    });

    expect(result.claimed).toBe(true);
    expect(result.retryingFailedEvent).toBe(true);
    expect(rows.get(baseClaim.id)).toMatchObject({
      orderId: "order_1",
      status: "processing",
      result: JSON.stringify({ retry: true }),
      processedAt: 1_000,
    });
  });

  it("atomically reclaims stale processing events", async () => {
    const { db, rows } = createWebhookDb([
      {
        id: baseClaim.id,
        provider: "stripe",
        eventType: "payment_intent.succeeded",
        orderId: "order_1",
        status: "processing",
        result: null,
        processedAt: 1_000 - DEFAULT_WEBHOOK_PROCESSING_LEASE_SECONDS - 1,
      },
    ]);

    const result = await claimWebhookEvent(db, baseClaim);

    expect(result.claimed).toBe(true);
    expect(result.reclaimingStaleProcessingEvent).toBe(true);
    expect(rows.get(baseClaim.id)).toMatchObject({
      status: "processing",
      processedAt: 1_000,
    });
  });

  it("allows only one stale processing reclaim to win", async () => {
    const { db } = createWebhookDb([
      {
        id: baseClaim.id,
        provider: "stripe",
        eventType: "payment_intent.succeeded",
        orderId: "order_1",
        status: "processing",
        result: null,
        processedAt: 1_000 - DEFAULT_WEBHOOK_PROCESSING_LEASE_SECONDS - 1,
      },
    ]);

    const first = await claimWebhookEvent(db, baseClaim);
    const second = await claimWebhookEvent(db, baseClaim);

    expect(first.claimed).toBe(true);
    expect(first.reclaimingStaleProcessingEvent).toBe(true);
    expect(second.claimed).toBe(false);
    expect(second.existing?.status).toBe("processing");
  });

  it("does not reclaim fresh processing events", async () => {
    const { db, rows } = createWebhookDb([
      {
        id: baseClaim.id,
        provider: "stripe",
        eventType: "payment_intent.succeeded",
        orderId: "order_1",
        status: "processing",
        result: null,
        processedAt: 1_000 - DEFAULT_WEBHOOK_PROCESSING_LEASE_SECONDS + 1,
      },
    ]);

    const result = await claimWebhookEvent(db, baseClaim);

    expect(result.claimed).toBe(false);
    expect(result.existing?.status).toBe("processing");
    expect(rows.get(baseClaim.id)?.processedAt).toBe(1_000 - DEFAULT_WEBHOOK_PROCESSING_LEASE_SECONDS + 1);
  });

  it("keeps queued and processed events deduplicated", async () => {
    for (const status of ["queued", "processed"] as const) {
      const { db } = createWebhookDb([
        {
          id: baseClaim.id,
          provider: "stripe",
          eventType: "payment_intent.succeeded",
          orderId: "order_1",
          status,
          result: null,
          processedAt: 1,
        },
      ]);

      const result = await claimWebhookEvent(db, baseClaim);

      expect(result).toMatchObject({
        claimed: false,
        existing: { status },
      });
    }
  });

  it("throws insert failures when no existing claim is found", async () => {
    const { db } = createWebhookDb([], 1_000, { forceInsertError: true });

    await expect(claimWebhookEvent(db, baseClaim)).rejects.toThrow("temporary insert failure");
  });
});
