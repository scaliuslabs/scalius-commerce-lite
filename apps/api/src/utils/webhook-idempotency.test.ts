import { describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import {
  DEFAULT_WEBHOOK_PROCESSING_LEASE_SECONDS,
  claimWebhookEvent,
  failStaleQueuedPaymentWebhookEvents,
  recordPaymentWebhookDlqEvidence,
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

function createStaleQueuedWebhookSweepDb(
  initialRows: StoredWebhookEvent[],
  cutoffSeconds: number,
): { db: Database; rows: Map<string, StoredWebhookEvent> } {
  const rows = new Map(initialRows.map((row) => [row.id, { ...row }]));
  let selectedIds: string[] = [];
  let updateLimit = 0;

  const paymentProviders = new Set(["stripe", "sslcommerz", "polar"]);
  const staleQueuedRows = () => [...rows.values()]
    .filter((row) =>
      row.status === "queued" &&
      paymentProviders.has(row.provider) &&
      row.processedAt <= cutoffSeconds,
    )
    .sort((left, right) => left.processedAt - right.processedAt);

  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async (limit: number) => {
            updateLimit = Math.max(0, limit - 1);
            const selected = staleQueuedRows().slice(0, limit);
            selectedIds = selected.map((row) => row.id);
            return selected.map((row) => ({
              id: row.id,
              provider: row.provider,
              eventType: row.eventType,
              orderId: row.orderId,
              processedAt: row.processedAt,
            }));
          },
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            const targetIds = new Set(selectedIds.slice(0, updateLimit));
            const updated: Array<{ id: string }> = [];
            for (const id of targetIds) {
              const row = rows.get(id);
              if (!row || row.status !== "queued") continue;
              rows.set(id, {
                ...row,
                status: String(values.status),
                result: String(values.result),
              });
              updated.push({ id });
            }
            return updated;
          },
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

  it("marks only stale queued payment webhook events failed in bounded batches", async () => {
    const cutoffSeconds = 1_000;
    const { db, rows } = createStaleQueuedWebhookSweepDb([
      {
        id: "stripe:payment_intent.succeeded:evt_old",
        provider: "stripe",
        eventType: "payment_intent.succeeded",
        orderId: "order_1",
        status: "queued",
        result: null,
        processedAt: 900,
      },
      {
        id: "polar:order.paid:evt_old",
        provider: "polar",
        eventType: "order.paid",
        orderId: "order_2",
        status: "queued",
        result: null,
        processedAt: 950,
      },
      {
        id: "sslcommerz:ipn:evt_extra",
        provider: "sslcommerz",
        eventType: "ipn",
        orderId: "order_3",
        status: "queued",
        result: null,
        processedAt: 990,
      },
      {
        id: "pathao:shipment:evt_old",
        provider: "pathao",
        eventType: "shipment",
        orderId: "order_4",
        status: "queued",
        result: null,
        processedAt: 800,
      },
      {
        id: "stripe:payment_intent.succeeded:evt_fresh",
        provider: "stripe",
        eventType: "payment_intent.succeeded",
        orderId: "order_5",
        status: "queued",
        result: null,
        processedAt: 1_001,
      },
    ], cutoffSeconds);

    const result = await failStaleQueuedPaymentWebhookEvents(db, cutoffSeconds, { limit: 2 });

    expect(result).toEqual({
      scanned: 2,
      failed: 2,
      limit: 2,
      hasMore: true,
    });
    expect(rows.get("stripe:payment_intent.succeeded:evt_old")?.status).toBe("failed");
    expect(rows.get("polar:order.paid:evt_old")?.status).toBe("failed");
    expect(rows.get("sslcommerz:ipn:evt_extra")?.status).toBe("queued");
    expect(rows.get("pathao:shipment:evt_old")?.status).toBe("queued");
    expect(rows.get("stripe:payment_intent.succeeded:evt_fresh")?.status).toBe("queued");
    expect(JSON.parse(rows.get("stripe:payment_intent.succeeded:evt_old")?.result ?? "{}")).toMatchObject({
      reason: "stale_queued_payment_webhook",
      cutoffSeconds,
      count: 2,
    });
  });

  it("throws insert failures when no existing claim is found", async () => {
    const { db } = createWebhookDb([], 1_000, { forceInsertError: true });

    await expect(claimWebhookEvent(db, baseClaim)).rejects.toThrow("temporary insert failure");
  });

  it("marks queued payment webhook events failed when DLQ evidence is archived", async () => {
    const { db, rows } = createWebhookDb([
      {
        id: baseClaim.id,
        provider: "stripe",
        eventType: "payment_intent.succeeded",
        orderId: "order_1",
        status: "queued",
        result: JSON.stringify({ sourceEventId: "evt_1" }),
        processedAt: 900,
      },
    ]);

    const result = await recordPaymentWebhookDlqEvidence(db, {
      webhookEventId: baseClaim.id,
      fallbackEventId: "stripe:payment.stripe.confirmed.dlq:msg_1",
      provider: "stripe",
      eventType: "payment.stripe.confirmed",
      orderId: "order_1",
      queueMessageId: "msg_1",
      queueType: "payment.stripe.confirmed",
      attempts: 5,
      observedAtSeconds: 1_200,
      messageTimestampSeconds: 1_100,
      payment: { paymentIntentId: "pi_1", amount: 12345, currency: "usd" },
    });

    expect(result).toEqual({ id: baseClaim.id, status: "failed", inserted: false });
    expect(rows.get(baseClaim.id)?.status).toBe("failed");
    expect(JSON.parse(rows.get(baseClaim.id)?.result ?? "{}")).toMatchObject({
      reason: "payment_events_dlq",
      queueMessageId: "msg_1",
      queueType: "payment.stripe.confirmed",
      orderId: "order_1",
      attempts: 5,
      previousStatus: "queued",
      previousResult: { sourceEventId: "evt_1" },
      payment: { paymentIntentId: "pi_1", amount: 12345, currency: "usd" },
    });
  });

  it("records DLQ evidence without downgrading already processed payment webhook rows", async () => {
    const { db, rows } = createWebhookDb([
      {
        id: baseClaim.id,
        provider: "stripe",
        eventType: "payment_intent.succeeded",
        orderId: "order_1",
        status: "processed",
        result: JSON.stringify({ outcome: "confirmed" }),
        processedAt: 900,
      },
    ]);

    const result = await recordPaymentWebhookDlqEvidence(db, {
      webhookEventId: baseClaim.id,
      fallbackEventId: "stripe:payment.stripe.confirmed.dlq:msg_1",
      provider: "stripe",
      eventType: "payment.stripe.confirmed",
      orderId: "order_1",
      queueMessageId: "msg_1",
      queueType: "payment.stripe.confirmed",
      attempts: 5,
      observedAtSeconds: 1_200,
      messageTimestampSeconds: 1_100,
      payment: { paymentIntentId: "pi_1" },
    });

    expect(result).toEqual({ id: baseClaim.id, status: "processed", inserted: false });
    expect(rows.get(baseClaim.id)?.status).toBe("processed");
    expect(JSON.parse(rows.get(baseClaim.id)?.result ?? "{}")).toMatchObject({
      reason: "payment_events_dlq",
      previousStatus: "processed",
      previousResult: { outcome: "confirmed" },
    });
  });

  it("inserts fallback failed rows when DLQ evidence has no prior webhook event", async () => {
    const { db, rows } = createWebhookDb();

    const result = await recordPaymentWebhookDlqEvidence(db, {
      webhookEventId: null,
      fallbackEventId: "stripe:payment.stripe.confirmed.dlq:msg_legacy",
      provider: "stripe",
      eventType: "payment.stripe.confirmed",
      orderId: "order_legacy",
      queueMessageId: "msg_legacy",
      queueType: "payment.stripe.confirmed",
      attempts: 5,
      observedAtSeconds: 1_200,
      messageTimestampSeconds: 1_100,
      payment: { paymentIntentId: "pi_legacy" },
    });

    expect(result).toEqual({
      id: "stripe:payment.stripe.confirmed.dlq:msg_legacy",
      status: "failed",
      inserted: true,
    });
    expect(rows.get("stripe:payment.stripe.confirmed.dlq:msg_legacy")).toMatchObject({
      provider: "stripe",
      eventType: "payment.stripe.confirmed",
      orderId: "order_legacy",
      status: "failed",
    });
  });
});
