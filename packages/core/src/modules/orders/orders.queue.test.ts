import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderIngestQueueMessage } from "./orders.queue";

const mocks = vi.hoisted(() => ({
  reserveStockBatch: vi.fn(),
  releaseMultiple: vi.fn(),
  initCODTracking: vi.fn(),
}));

vi.mock("../inventory", () => ({
  reserveStockBatch: mocks.reserveStockBatch,
  releaseMultiple: mocks.releaseMultiple,
}));

vi.mock("../payments/cod", () => ({
  initCODTracking: mocks.initCODTracking,
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
  discount?: { maxUses: number | null; limitOnePerCustomer: boolean | null };
  totalDiscountUsage?: number;
} = {}) {
  const db = {
    select(projection?: Record<string, unknown>) {
      return {
        from() {
          return {
            where() {
              return {
                get: async () => {
                  if (projection && "inventoryAction" in projection) return null;
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
    mocks.releaseMultiple.mockResolvedValue({ success: true, results: [] });
    mocks.initCODTracking.mockResolvedValue(undefined);
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
  });
});
