// Payment events without a queue: claimed once in webhook_events with the
// event as payload, applied right after the response, retried from the row by
// the scheduled drain with backoff, and `failed` (the dead-letter state the
// order page shows) after six attempts. The payment kernel, notifications and
// side effects are stubbed; the webhook_events state machine is real.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { orderPayments } from "@scalius/database/schema";
import { sql } from "drizzle-orm";

const mocks = vi.hoisted(() => ({
  processPaymentConfirmed: vi.fn(),
  processPaymentFailed: vi.fn(),
  processExistingMetaPurchaseOutboxForOrder: vi.fn(),
  sendOrderCreatedNotification: vi.fn(),
  sendOrderBalancePaidNotification: vi.fn(),
  runOrderAutoFulfil: vi.fn(),
  flushEventsAfterWrite: vi.fn(),
}));

vi.mock("@scalius/core/modules/payments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/payments")>()),
  processPaymentConfirmed: mocks.processPaymentConfirmed,
  processPaymentFailed: mocks.processPaymentFailed,
}));
vi.mock("@scalius/core/integrations/meta/purchase-outbox", () => ({
  processExistingMetaPurchaseOutboxForOrder: mocks.processExistingMetaPurchaseOutboxForOrder,
}));
vi.mock("../utils/order-notifications", () => ({
  sendOrderCreatedNotification: mocks.sendOrderCreatedNotification,
  sendOrderBalancePaidNotification: mocks.sendOrderBalancePaidNotification,
}));
vi.mock("./auto-fulfil", () => ({ runOrderAutoFulfil: mocks.runOrderAutoFulfil }));
vi.mock("../events/flush", () => ({ flushEventsAfterWrite: mocks.flushEventsAfterWrite }));

import { claimAndApplyPaymentEvent } from "../routes/payment/payment-events";
import { drainPaymentEvents } from "./payment-events";
import type { PaymentEvent } from "@scalius/core/modules/payments";

const confirmed: PaymentEvent = {
  kind: "confirmed",
  orderId: "order_1",
  providerRef: "pi_1",
  amountMinor: 12_345,
  currency: "USD",
  eventType: "payment_intent.succeeded",
  eventId: "evt_1",
};
const ROW_ID = "stripe:payment_intent.succeeded:evt_1";

describe("payment events applied after the response and retried from their row", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); }, passThroughOnException() {} } as unknown as ExecutionContext;
  const env = { CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") } as unknown as Env;
  const caller = { env, executionCtx: ctx };
  const settle = async () => { while (pending.length) await pending.shift(); };
  const row = () => sqlite.prepare("SELECT status, attempts, payload IS NOT NULL AS has_payload, next_attempt_at - unixepoch() AS wait, result FROM webhook_events").get() as Record<string, unknown>;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.processExistingMetaPurchaseOutboxForOrder.mockResolvedValue({ processed: true });
    mocks.sendOrderCreatedNotification.mockResolvedValue({ orderId: "order_1", enqueued: true });
    mocks.sendOrderBalancePaidNotification.mockResolvedValue({ orderId: "order_1", enqueued: true });
    mocks.runOrderAutoFulfil.mockResolvedValue(undefined);
    mocks.flushEventsAfterWrite.mockResolvedValue({});
  });
  afterEach(() => { sqlite.close(); vi.restoreAllMocks(); });

  it("applies a confirmed payment once after the response, with its notification, fulfilment and events", async () => {
    mocks.processPaymentConfirmed.mockResolvedValue({ success: true });

    await expect(claimAndApplyPaymentEvent({ db, caller, provider: "stripe", event: confirmed, source: "webhook" })).resolves.toEqual({ status: "accepted" });
    expect(mocks.processPaymentConfirmed).not.toHaveBeenCalled();
    expect(row()).toMatchObject({ status: "processing", attempts: 1, has_payload: 1 });
    await settle();

    expect(mocks.processPaymentConfirmed).toHaveBeenCalledWith(db, expect.objectContaining({ orderId: "order_1", provider: "stripe", amountMinor: 12_345 }));
    expect(mocks.sendOrderCreatedNotification).toHaveBeenCalledWith(expect.objectContaining({ orderId: "order_1", source: "payment-stripe-confirmed" }));
    expect(mocks.sendOrderBalancePaidNotification).not.toHaveBeenCalled();
    expect(mocks.runOrderAutoFulfil).toHaveBeenCalledWith(db, env, ctx, "order_1");
    expect(mocks.processExistingMetaPurchaseOutboxForOrder).toHaveBeenCalledWith(expect.objectContaining({ orderId: "order_1" }));
    expect(mocks.flushEventsAfterWrite).toHaveBeenCalledWith(db, env, ctx, { tableTopics: [] });
    expect(row()).toMatchObject({ status: "processed" });
    expect(JSON.parse(String(row().result))).toMatchObject({ outcome: "confirmed", gateway: "stripe", orderId: "order_1", attempts: 1 });

    // A provider resend of the same event is a duplicate: nothing runs again.
    await expect(claimAndApplyPaymentEvent({ db, caller, provider: "stripe", event: confirmed, source: "webhook" }))
      .resolves.toEqual({ status: "duplicate", existingStatus: "processed" });
    await settle();
    expect(mocks.processPaymentConfirmed).toHaveBeenCalledTimes(1);
  });

  it("tells the dashboard about the realtime tables the payment wrote", async () => {
    mocks.processPaymentConfirmed.mockImplementationOnce(async (database: Database) => {
      await database.update(orderPayments).set({ status: "succeeded" }).where(sql`0`);
      return { success: true };
    });
    await claimAndApplyPaymentEvent({ db, caller, provider: "stripe", event: confirmed, source: "webhook" });
    await settle();
    expect(mocks.flushEventsAfterWrite).toHaveBeenCalledWith(db, env, ctx, { tableTopics: ["payments"] });
  });

  it("sends the balance-paid notice in major units for a balance payment, and no side effects for a replay", async () => {
    mocks.processPaymentConfirmed.mockResolvedValueOnce({ success: true, paymentType: "balance" });
    await claimAndApplyPaymentEvent({ db, caller, provider: "stripe", event: { ...confirmed, currency: "BDT", amountMinor: 6_500, paymentType: "balance" }, source: "webhook" });
    await settle();
    expect(mocks.sendOrderBalancePaidNotification).toHaveBeenCalledWith(expect.objectContaining({ amount: 65, gateway: "stripe", source: "payment-stripe-balance-paid" }));
    expect(mocks.sendOrderCreatedNotification).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.processPaymentConfirmed.mockResolvedValueOnce({ success: true, alreadyProcessed: true });
    await claimAndApplyPaymentEvent({ db, caller, provider: "stripe", event: { ...confirmed, eventId: "evt_2" }, source: "buyer_return" });
    await settle();
    expect(mocks.sendOrderCreatedNotification).not.toHaveBeenCalled();
    expect(mocks.runOrderAutoFulfil).not.toHaveBeenCalled();
    expect(mocks.processExistingMetaPurchaseOutboxForOrder).not.toHaveBeenCalled();
  });

  it("records a guard refusal for manual reconciliation and keeps provider refunds audit-only", async () => {
    mocks.processPaymentConfirmed.mockResolvedValue({ success: false, retryable: false, error: "Cannot pay a cancelled order" });
    await claimAndApplyPaymentEvent({ db, caller, provider: "stripe", event: confirmed, source: "webhook" });
    await settle();
    expect(row()).toMatchObject({ status: "manual_reconciliation" });
    expect(JSON.parse(String(row().result))).toMatchObject({ outcome: "manual_reconciliation", error: "Cannot pay a cancelled order" });
    expect(mocks.sendOrderCreatedNotification).not.toHaveBeenCalled();

    sqlite.exec("DELETE FROM webhook_events");
    await claimAndApplyPaymentEvent({ db, caller, provider: "stripe", event: { kind: "refund_observed", orderId: "order_1", providerRef: "pi_1", details: { amountRefunded: 1500 }, eventType: "charge.refunded", eventId: "evt_r" }, source: "webhook" });
    await settle();
    expect(row()).toMatchObject({ status: "manual_reconciliation" });
    expect(JSON.parse(String(row().result))).toMatchObject({ outcome: "external_refund_observed", amountRefunded: 1500 });
  });

  it("ends a cancelled attempt through the failure kernel without touching stock", async () => {
    const cancelled: PaymentEvent = {
      kind: "cancelled",
      orderId: "order_1",
      providerRef: "pi_1",
      correlationId: "order_1_full_ABCDEF12",
      eventType: "payment_intent.canceled",
      eventId: "evt_c",
    };
    mocks.processPaymentFailed.mockResolvedValueOnce({ applied: true });
    await claimAndApplyPaymentEvent({ db, caller, provider: "stripe", event: cancelled, source: "webhook" });
    await settle();
    expect(mocks.processPaymentFailed).toHaveBeenCalledWith(db, {
      orderId: "order_1",
      provider: "stripe",
      providerRef: "pi_1",
      correlationId: "order_1_full_ABCDEF12",
    });
    expect(JSON.parse(String(row().result))).toMatchObject({ outcome: "canceled" });

    // An event for another attempt (an old intent, another app's provider) is recorded and ignored.
    sqlite.exec("DELETE FROM webhook_events");
    mocks.processPaymentFailed.mockResolvedValueOnce({ applied: false });
    await claimAndApplyPaymentEvent({ db, caller, provider: "stripe", event: { ...cancelled, eventId: "evt_c2" }, source: "webhook" });
    await settle();
    expect(row()).toMatchObject({ status: "processed" });
    expect(JSON.parse(String(row().result))).toMatchObject({ outcome: "canceled_ignored" });
  });

  it("records a payment whose released stock could not be reserved again, and ships nothing", async () => {
    mocks.processPaymentConfirmed.mockResolvedValue({ success: true, paymentType: "full", inventoryShortfall: true });
    await claimAndApplyPaymentEvent({ db, caller, provider: "stripe", event: confirmed, source: "webhook" });
    await settle();
    expect(row()).toMatchObject({ status: "manual_reconciliation" });
    expect(JSON.parse(String(row().result))).toMatchObject({ outcome: "confirmed_stock_unavailable" });
    expect(mocks.sendOrderCreatedNotification).toHaveBeenCalled();
    expect(mocks.runOrderAutoFulfil).not.toHaveBeenCalled();
  });

  it("retries a failed attempt from the row with backoff until it fails after six attempts", async () => {
    mocks.processPaymentConfirmed.mockResolvedValue({ success: false, error: "D1 batch failed" });
    await claimAndApplyPaymentEvent({ db, caller, provider: "stripe", event: confirmed, source: "webhook" });
    await settle();
    expect(row()).toMatchObject({ status: "retrying", attempts: 1 });
    expect(Number(row().wait)).toBeGreaterThanOrEqual(55);

    // Not due yet: the tick leaves it.
    await expect(drainPaymentEvents(db, env, ctx)).resolves.toEqual({ scanned: 0, processed: 0 });
    for (let attempt = 2; attempt <= 6; attempt += 1) {
      sqlite.exec("UPDATE webhook_events SET next_attempt_at = unixepoch() - 1");
      await drainPaymentEvents(db, env, ctx);
      await settle();
      expect(row()).toMatchObject({ attempts: attempt, status: attempt < 6 ? "retrying" : "failed" });
    }
    expect(Number(row().wait ?? 0)).toBe(0);
    expect(JSON.parse(String(row().result))).toMatchObject({ reason: "retries_exhausted", attempts: 6 });
    expect(mocks.processPaymentConfirmed).toHaveBeenCalledTimes(6);

    // Terminal: the drain never takes it again, but the provider's resend reclaims it.
    await expect(drainPaymentEvents(db, env, ctx)).resolves.toEqual({ scanned: 0, processed: 0 });
    mocks.processPaymentConfirmed.mockResolvedValue({ success: true });
    await expect(claimAndApplyPaymentEvent({ db, caller, provider: "stripe", event: confirmed, source: "webhook" })).resolves.toEqual({ status: "accepted" });
    await settle();
    expect(row()).toMatchObject({ status: "processed", attempts: 1 });
  });

  it("reclaims an attempt whose invocation died once its lease ends", async () => {
    mocks.processPaymentConfirmed.mockResolvedValue({ success: true });
    // The claim committed, but the invocation ended before the attempt ran.
    sqlite.prepare("INSERT INTO webhook_events (id, provider, event_type, order_id, status, payload, attempts, processed_at) VALUES (?, 'stripe', 'payment.confirmed', 'order_1', 'processing', ?, 1, unixepoch())")
      .run(ROW_ID, JSON.stringify({ provider: "stripe", event: confirmed }));
    await expect(drainPaymentEvents(db, env, ctx)).resolves.toEqual({ scanned: 0, processed: 0 });

    sqlite.exec("UPDATE webhook_events SET processed_at = unixepoch() - 301");
    await expect(drainPaymentEvents(db, env, ctx)).resolves.toEqual({ scanned: 1, processed: 1 });
    await settle();
    expect(row()).toMatchObject({ status: "processed", attempts: 2 });
    expect(mocks.processPaymentConfirmed).toHaveBeenCalledTimes(1);
    expect(ROW_ID).toBe(String((sqlite.prepare("SELECT id FROM webhook_events").get() as { id: string }).id));
  });
});
