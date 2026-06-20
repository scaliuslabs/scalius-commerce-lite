import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderIngestQueueMessage } from "./orders.queue";

const mocks = vi.hoisted(() => ({
  reserveStockBatch: vi.fn(),
  releaseMultiple: vi.fn(),
  initCODTracking: vi.fn(),
  buildOrderCreatedNotificationDedupeKey: vi.fn((orderId: string) => `order_created:${orderId}`),
  createOrderNotificationOutboxInsertValues: vi.fn((input: Record<string, unknown>) => ({
    id: `outbox_${input.orderId}`,
    ...input,
    payload: JSON.stringify(input),
    status: "pending",
  })),
  recordAndEnqueueOrderNotification: vi.fn(),
}));

vi.mock("../inventory", () => ({
  reserveStockBatch: mocks.reserveStockBatch,
  releaseMultiple: mocks.releaseMultiple,
}));

vi.mock("../payments/cod", () => ({
  initCODTracking: mocks.initCODTracking,
}));

vi.mock("../notifications/order-notification-outbox", () => ({
  buildOrderCreatedNotificationDedupeKey: mocks.buildOrderCreatedNotificationDedupeKey,
  createOrderNotificationOutboxInsertValues: mocks.createOrderNotificationOutboxInsertValues,
  recordAndEnqueueOrderNotification: mocks.recordAndEnqueueOrderNotification,
}));

import { handleOrderIngestBatch } from "./orders.queue";

function createPayload(
  orderId: string,
  overrides: Partial<OrderIngestQueueMessage> = {},
): OrderIngestQueueMessage {
  return {
    type: "order.ingest",
    checkoutToken: `chk_${orderId}`,
    existingCustomer: { id: `cust_${orderId}` },
    orderData: {
      id: orderId,
      customerName: "Test Customer",
      customerPhone: `0170000${orderId.slice(-3).padStart(3, "0")}`,
      customerEmail: "customer@example.com",
      shippingAddress: "123 Test Road",
      city: "city_1",
      zone: "zone_1",
      area: null,
      cityName: "City",
      zoneName: "Zone",
      areaName: null,
      notes: null,
      totalAmount: 100,
      shippingCharge: 0,
      discountAmount: 0,
      status: "pending",
      paymentMethod: "stripe",
      paymentStatus: "unpaid",
      paidAmount: 0,
      balanceDue: 100,
      fulfillmentStatus: "pending",
      inventoryPool: "regular",
      inventoryAction: "reserved",
    },
    items: [
      {
        productId: `prod_${orderId}`,
        variantId: `variant_${orderId}`,
        quantity: 1,
        price: 100,
        productName: "Test Product",
        variantLabel: null,
      },
    ],
    discountUsage: null,
    requestUrl: "http://localhost/api/v1/orders",
    ...overrides,
  };
}

function createMessage(body: OrderIngestQueueMessage): Message<OrderIngestQueueMessage> {
  return {
    id: `msg_${body.orderData.id}`,
    timestamp: new Date("2026-01-01T00:00:00.000Z"),
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function createBatch(messages: Message<OrderIngestQueueMessage>[]): MessageBatch<OrderIngestQueueMessage> {
  return {
    queue: "order-ingest",
    messages,
    metadata: {
      metrics: {
        backlogCount: messages.length,
        backlogBytes: 0,
        oldestMessageTimestamp: messages[0]?.timestamp,
      },
    },
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  };
}

function createEnvMock() {
  const writes: Array<{ key: string; value: string }> = [];
  return {
    env: {
      CACHE: {
        get: vi.fn(async () => null),
        put: vi.fn(async (key: string, value: string) => {
          writes.push({ key, value });
        }),
      },
    },
    writes,
  };
}

function createDbMock(options: {
  batchRejects?: boolean;
  batchOutcomes?: Array<"resolve" | "reject">;
  batchErrors?: Error[];
  discount?: { maxUses: number | null; limitOnePerCustomer: boolean | null };
  totalDiscountUsage?: number;
  orderLookupResults?: Array<{ id: string; inventoryAction: string | null } | null>;
  reservationMovementRows?: Array<{ variantId: string; type: string; quantity: number }>;
} = {}) {
  const db = {
    select(projection?: Record<string, unknown>) {
      return {
        from() {
          return {
            where() {
              return {
                all: async () => {
                  if (projection && "variantId" in projection && "type" in projection) {
                    return options.reservationMovementRows ?? [];
                  }
                  return [];
                },
                get: async () => {
                  if (projection && "inventoryAction" in projection) {
                    return options.orderLookupResults?.length
                      ? options.orderLookupResults.shift() ?? null
                      : null;
                  }
                  if (projection && "maxUses" in projection) return options.discount ?? null;
                  if (projection && "count" in projection) return { count: options.totalDiscountUsage ?? 0 };
                  return null;
                },
                limit() {
                  return {
                    get: async () => null,
                  };
                },
              };
            },
            leftJoin() {
              return {
                where() {
                  return {
                    limit() {
                      return {
                        get: async () => null,
                      };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
    insert() {
      return {
        values: vi.fn(() => ({ kind: "insert" })),
      };
    },
    update() {
      return {
        set: vi.fn(() => ({
          where: vi.fn(() => ({ kind: "update" })),
        })),
      };
    },
    batch: vi.fn(async () => {
      const batchError = options.batchErrors?.shift();
      if (batchError) throw batchError;
      const outcome = options.batchOutcomes?.shift();
      if (outcome === "reject") throw new Error("D1 batch failed");
      if (outcome === "resolve") return [];
      if (options.batchRejects) throw new Error("D1 batch failed");
      return [];
    }),
  };

  return db;
}

describe("handleOrderIngestBatch isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.releaseMultiple.mockResolvedValue({ success: true, results: [] });
    mocks.initCODTracking.mockResolvedValue(undefined);
    mocks.recordAndEnqueueOrderNotification.mockResolvedValue({
      outboxId: "outbox_order",
      dedupeKey: "order_created:order",
      created: false,
      enqueued: true,
    });
  });

  it("retries only the order whose stock reservation fails", async () => {
    mocks.reserveStockBatch.mockImplementation(async (_db, items: Array<{ orderId?: string }>) => {
      const orderId = items[0]?.orderId;
      if (orderId === "order_bad") {
        return { success: false, results: [], error: "Insufficient stock for variant" };
      }
      return { success: true, results: [] };
    });

    const good = createMessage(createPayload("order_good"));
    const bad = createMessage(createPayload("order_bad"));
    const { env } = createEnvMock();

    await handleOrderIngestBatch(
      createBatch([good, bad]) as never,
      createDbMock() as never,
      env as never,
    );

    expect(good.ack).toHaveBeenCalledTimes(1);
    expect(good.retry).not.toHaveBeenCalled();
    expect(bad.ack).not.toHaveBeenCalled();
    expect(bad.retry).toHaveBeenCalledWith({ delaySeconds: 15 });
  });

  it("records and enqueues order-created notifications for accepted orders", async () => {
    mocks.reserveStockBatch.mockResolvedValue({ success: true, results: [] });

    const message = createMessage(createPayload("order_accepted", {
      orderData: {
        ...createPayload("order_accepted").orderData,
        status: "pending",
        paymentMethod: "cod",
      },
    }));
    const { env } = createEnvMock();

    await handleOrderIngestBatch(
      createBatch([message]) as never,
      createDbMock() as never,
      env as never,
    );

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(mocks.createOrderNotificationOutboxInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey: "order_created:order_accepted",
        orderId: "order_accepted",
        notificationType: "order_created",
      }),
    );
    expect(mocks.recordAndEnqueueOrderNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        notification: expect.objectContaining({
          dedupeKey: "order_created:order_accepted",
          orderId: "order_accepted",
          notificationType: "order_created",
        }),
      }),
    );
  });

  it("defers order-created notifications for incomplete online orders", async () => {
    mocks.reserveStockBatch.mockResolvedValue({ success: true, results: [] });
    const basePayload = createPayload("order_online");
    const message = createMessage({
      ...basePayload,
      orderData: {
        ...basePayload.orderData,
        status: "incomplete",
        paymentMethod: "sslcommerz",
      },
    });
    const { env } = createEnvMock();

    await handleOrderIngestBatch(
      createBatch([message]) as never,
      createDbMock() as never,
      env as never,
    );

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(mocks.createOrderNotificationOutboxInsertValues).not.toHaveBeenCalled();
    expect(mocks.recordAndEnqueueOrderNotification).not.toHaveBeenCalled();
  });

  it("does not retry an already rejected discount message when the remaining DB batch fails", async () => {
    mocks.reserveStockBatch.mockResolvedValue({ success: true, results: [] });

    const firstDiscount = createMessage(createPayload("order_disc_a", {
      discountUsage: { discountId: "discount_1", amountDiscounted: 10 },
    }));
    const secondDiscount = createMessage(createPayload("order_disc_b", {
      discountUsage: { discountId: "discount_1", amountDiscounted: 10 },
    }));
    const { env } = createEnvMock();

    await handleOrderIngestBatch(
      createBatch([firstDiscount, secondDiscount]) as never,
      createDbMock({
        batchRejects: true,
        discount: { maxUses: 1, limitOnePerCustomer: false },
        totalDiscountUsage: 0,
      }) as never,
      env as never,
    );

    expect(firstDiscount.ack).toHaveBeenCalledTimes(1);
    expect(firstDiscount.retry).not.toHaveBeenCalled();
    expect(secondDiscount.ack).not.toHaveBeenCalled();
    expect(secondDiscount.retry).toHaveBeenCalledWith({ delaySeconds: 15 });
  });

  it("isolates deterministic DB batch errors to the order that still fails", async () => {
    mocks.reserveStockBatch.mockResolvedValue({ success: true, results: [] });

    const good = createMessage(createPayload("order_good"));
    const poison = createMessage(createPayload("order_poison"));
    const { env } = createEnvMock();

    await handleOrderIngestBatch(
      createBatch([good, poison]) as never,
      createDbMock({
        batchOutcomes: [
          "reject", // shared batch fails
          "resolve", // good order succeeds in isolated replay
          "reject", // poison order remains broken
        ],
      }) as never,
      env as never,
    );

    expect(good.ack).toHaveBeenCalledTimes(1);
    expect(good.retry).not.toHaveBeenCalled();
    expect(poison.ack).not.toHaveBeenCalled();
    expect(poison.retry).toHaveBeenCalledWith({ delaySeconds: 15 });
    expect(mocks.reserveStockBatch).toHaveBeenCalledTimes(2);
    expect(mocks.releaseMultiple).toHaveBeenCalledTimes(1);
    expect(mocks.releaseMultiple).toHaveBeenCalledWith(
      expect.anything(),
      [
        {
          orderId: "order_poison",
          variantId: "variant_order_poison",
          quantity: 1,
          pool: "regular",
        },
      ],
      "order_poison",
    );
  });

  it("replays an isolated order with its existing reservation instead of reserving twice", async () => {
    mocks.reserveStockBatch.mockResolvedValue({ success: true, results: [] });

    const msg = createMessage(createPayload("order_replay"));
    const { env } = createEnvMock();

    await handleOrderIngestBatch(
      createBatch([msg]) as never,
      createDbMock({
        batchOutcomes: [
          "reject", // shared batch fails after reservation
          "resolve", // isolated replay succeeds with the original reservation
        ],
      }) as never,
      env as never,
    );

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
    expect(mocks.reserveStockBatch).toHaveBeenCalledTimes(1);
    expect(mocks.reserveStockBatch).toHaveBeenCalledWith(
      expect.anything(),
      [{ variantId: "variant_order_replay", quantity: 1, orderId: "order_replay" }],
      "regular",
      { reservationKey: "checkout-ingest:v1" },
    );
    expect(mocks.releaseMultiple).not.toHaveBeenCalled();
  });

  it("reuses an active reservation on redelivery after a crash before order insert", async () => {
    mocks.reserveStockBatch.mockResolvedValue({ success: true, results: [] });

    const msg = createMessage(createPayload("order_reuse"));
    const { env } = createEnvMock();
    const db = createDbMock({
      orderLookupResults: [null],
      reservationMovementRows: [
        { variantId: "variant_order_reuse", type: "reserved", quantity: 1 },
      ],
    });

    await handleOrderIngestBatch(
      createBatch([msg]) as never,
      db as never,
      env as never,
    );

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
    expect(mocks.reserveStockBatch).not.toHaveBeenCalled();
    expect(db.batch).toHaveBeenCalledTimes(1);
  });

  it("releases a reused reservation before retrying when redelivered order insert still fails", async () => {
    mocks.reserveStockBatch.mockResolvedValue({ success: true, results: [] });

    const msg = createMessage(createPayload("order_reuse_fail"));
    const { env } = createEnvMock();

    await handleOrderIngestBatch(
      createBatch([msg]) as never,
      createDbMock({
        batchOutcomes: [
          "reject", // shared batch fails
          "reject", // isolated replay also fails
        ],
        orderLookupResults: [null, null],
        reservationMovementRows: [
          { variantId: "variant_order_reuse_fail", type: "reserved", quantity: 1 },
        ],
      }) as never,
      env as never,
    );

    expect(mocks.reserveStockBatch).not.toHaveBeenCalled();
    expect(mocks.releaseMultiple).toHaveBeenCalledWith(
      expect.anything(),
      [
        {
          orderId: "order_reuse_fail",
          variantId: "variant_order_reuse_fail",
          quantity: 1,
          pool: "regular",
        },
      ],
      "order_reuse_fail",
    );
    expect(msg.ack).not.toHaveBeenCalled();
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 15 });
  });

  it("fails closed on active reservation quantity mismatch", async () => {
    mocks.reserveStockBatch.mockResolvedValue({ success: true, results: [] });

    const msg = createMessage(createPayload("order_mismatch"));
    const { env, writes } = createEnvMock();

    await handleOrderIngestBatch(
      createBatch([msg]) as never,
      createDbMock({
        orderLookupResults: [null],
        reservationMovementRows: [
          { variantId: "variant_order_mismatch", type: "reserved", quantity: 2 },
        ],
      }) as never,
      env as never,
    );

    expect(mocks.reserveStockBatch).not.toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writes.at(-1)!.value)).toMatchObject({
      status: "failed",
      error: "Order ingestion needs manual inventory reconciliation before retry.",
    });
  });

  it("acks an ambiguous shared batch commit without releasing or reserving again", async () => {
    mocks.reserveStockBatch.mockResolvedValue({ success: true, results: [] });

    const msg = createMessage(createPayload("order_committed"));
    const { env } = createEnvMock();
    const db = createDbMock({
      batchOutcomes: ["reject"],
      orderLookupResults: [
        null, // Phase 1b redelivery guard
        { id: "order_committed", inventoryAction: "reserved" }, // After shared batch failure
      ],
    });

    await handleOrderIngestBatch(
      createBatch([msg]) as never,
      db as never,
      env as never,
    );

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
    expect(db.batch).toHaveBeenCalledTimes(1);
    expect(mocks.reserveStockBatch).toHaveBeenCalledTimes(1);
    expect(mocks.releaseMultiple).not.toHaveBeenCalled();
  });

  it("does not retry isolated failures unless the original reservation was released", async () => {
    mocks.reserveStockBatch.mockResolvedValue({ success: true, results: [] });
    mocks.releaseMultiple.mockResolvedValue({
      success: false,
      results: [],
      error: "release failed",
    });

    const msg = createMessage(createPayload("order_release_failed"));
    const { env, writes } = createEnvMock();

    await handleOrderIngestBatch(
      createBatch([msg]) as never,
      createDbMock({
        batchOutcomes: [
          "reject", // shared batch fails
          "reject", // isolated replay also fails
        ],
      }) as never,
      env as never,
    );

    expect(mocks.reserveStockBatch).toHaveBeenCalledTimes(1);
    expect(mocks.releaseMultiple).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writes.at(-1)!.value)).toMatchObject({
      status: "failed",
      error: "Order ingestion needs manual inventory reconciliation before retry.",
    });
  });

  it("fails terminal discount trigger conflicts without retrying the legacy queue message", async () => {
    mocks.reserveStockBatch.mockResolvedValue({ success: true, results: [] });

    const msg = createMessage(createPayload("order_discount_conflict", {
      discountUsage: { discountId: "discount_1", amountDiscounted: 25 },
    }));
    const { env, writes } = createEnvMock();

    await handleOrderIngestBatch(
      createBatch([msg]) as never,
      createDbMock({
        batchErrors: [
          new Error("D1 batch failed"),
          new Error("SQLITE_CONSTRAINT_TRIGGER: DISCOUNT_ONE_PER_CUSTOMER_EXCEEDED"),
        ],
      }) as never,
      env as never,
    );

    expect(mocks.reserveStockBatch).toHaveBeenCalledTimes(1);
    expect(mocks.releaseMultiple).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writes.at(-1)!.value)).toMatchObject({
      status: "failed",
      error: "Discount already used by this customer",
    });
  });
});
