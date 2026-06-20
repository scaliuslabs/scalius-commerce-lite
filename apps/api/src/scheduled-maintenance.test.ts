import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const db = { id: "db" };
  return {
    db,
    getDb: vi.fn(() => db),
    releaseExpiredReservations: vi.fn(),
    archiveStaleIncompleteOrders: vi.fn(),
    flushPendingOrderNotificationOutbox: vi.fn(),
    invalidateProductAvailabilityCaches: vi.fn(),
  };
});

vi.mock("@scalius/database/client", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@scalius/core/modules/inventory", () => ({
  releaseExpiredReservations: mocks.releaseExpiredReservations,
}));

vi.mock("@scalius/core/modules/orders/stale-incomplete-orders", () => ({
  archiveStaleIncompleteOrders: mocks.archiveStaleIncompleteOrders,
}));

vi.mock("@scalius/core/modules/notifications", () => ({
  flushPendingOrderNotificationOutbox: mocks.flushPendingOrderNotificationOutbox,
}));

vi.mock("./utils/cache-invalidation", () => ({
  invalidateProductAvailabilityCaches: mocks.invalidateProductAvailabilityCaches,
}));

import {
  INVENTORY_EXPIRY_SWEEP_LIMIT,
  ORDER_NOTIFICATION_OUTBOX_SWEEP_LIMIT,
  STALE_INCOMPLETE_ORDER_MAX_AGE_MINUTES,
  STALE_INCOMPLETE_ORDER_SWEEP_LIMIT,
  runScheduledMaintenance,
} from "./scheduled-maintenance";

function createEnv() {
  return {
    ORDER_NOTIFICATIONS_QUEUE: {
      send: vi.fn(),
    },
  } as unknown as Env;
}

function createExecutionContext() {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
}

describe("runScheduledMaintenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    mocks.releaseExpiredReservations.mockResolvedValue({
      found: 0,
      released: 0,
      limit: INVENTORY_EXPIRY_SWEEP_LIMIT,
      hasMore: false,
      releasedVariantIds: [],
      errors: [],
    });
    mocks.archiveStaleIncompleteOrders.mockResolvedValue({
      found: 0,
      limit: STALE_INCOMPLETE_ORDER_SWEEP_LIMIT,
      hasMore: false,
      archived: 0,
      failed: 0,
      archivedOrderIds: [],
      errors: [],
    });
    mocks.flushPendingOrderNotificationOutbox.mockResolvedValue({
      scanned: 0,
      enqueued: 0,
      failed: 0,
      skipped: 0,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs inventory expiry, stale hosted-payment cleanup, cache invalidation, and outbox flush", async () => {
    const now = new Date("2026-06-20T12:00:00.000Z");
    vi.setSystemTime(now);
    const env = createEnv();
    const executionCtx = createExecutionContext();

    mocks.releaseExpiredReservations.mockResolvedValue({
      found: 2,
      released: 1,
      limit: INVENTORY_EXPIRY_SWEEP_LIMIT,
      hasMore: false,
      releasedVariantIds: ["variant_1"],
      errors: [],
    });
    mocks.archiveStaleIncompleteOrders.mockResolvedValue({
      found: 1,
      limit: STALE_INCOMPLETE_ORDER_SWEEP_LIMIT,
      hasMore: false,
      archived: 1,
      failed: 0,
      archivedOrderIds: ["order_1"],
      errors: [],
    });
    mocks.flushPendingOrderNotificationOutbox.mockResolvedValue({
      scanned: 1,
      enqueued: 1,
      failed: 0,
      skipped: 0,
    });

    await runScheduledMaintenance(env, executionCtx);

    expect(mocks.getDb).toHaveBeenCalledWith(env);
    expect(mocks.releaseExpiredReservations).toHaveBeenCalledWith(mocks.db, 30, {
      limit: INVENTORY_EXPIRY_SWEEP_LIMIT,
    });
    expect(mocks.archiveStaleIncompleteOrders).toHaveBeenCalledWith(
      mocks.db,
      Math.floor(now.getTime() / 1000) - STALE_INCOMPLETE_ORDER_MAX_AGE_MINUTES * 60,
      { limit: STALE_INCOMPLETE_ORDER_SWEEP_LIMIT },
    );
    expect(mocks.invalidateProductAvailabilityCaches).toHaveBeenNthCalledWith(
      1,
      mocks.db,
      { variantIds: ["variant_1"] },
      { env, executionCtx },
    );
    expect(mocks.invalidateProductAvailabilityCaches).toHaveBeenNthCalledWith(
      2,
      mocks.db,
      { orderIds: ["order_1"] },
      { env, executionCtx },
    );
    expect(mocks.flushPendingOrderNotificationOutbox).toHaveBeenCalledWith({
      db: mocks.db,
      queue: env.ORDER_NOTIFICATIONS_QUEUE,
      limit: ORDER_NOTIFICATION_OUTBOX_SWEEP_LIMIT,
    });
  });

  it("does not invalidate availability caches when a sweep has no affected subjects", async () => {
    vi.setSystemTime(new Date("2026-06-20T12:00:00.000Z"));

    await runScheduledMaintenance(createEnv(), createExecutionContext());

    expect(mocks.invalidateProductAvailabilityCaches).not.toHaveBeenCalled();
    expect(mocks.flushPendingOrderNotificationOutbox).toHaveBeenCalled();
  });
});
