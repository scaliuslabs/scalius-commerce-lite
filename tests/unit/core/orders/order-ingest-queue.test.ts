import { afterEach, describe, expect, it, vi } from "vitest";
import {
  groupReservationEntriesByOrder,
  handleOrderIngestBatch,
  setCheckoutRetryStatus,
  type QueuedReservationEntry,
  type OrderIngestQueueMessage,
} from "../../../../packages/core/src/modules/orders/orders.queue";

afterEach(() => {
  vi.restoreAllMocks();
});

function createEnv(existingStatus: Record<string, unknown> | null = null): Env {
  return {
    CACHE: {
      get: vi.fn().mockResolvedValue(existingStatus ? JSON.stringify(existingStatus) : null),
      put: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as Env;
}

function createOrderIngestMessage(
  overrides: Partial<OrderIngestQueueMessage> = {},
): Message<OrderIngestQueueMessage> & { attempts: number } {
  const body = {
    type: "order.ingest",
    checkoutToken: "chk_test",
    existingCustomer: { id: "cust_existing" },
    orderData: {
      id: "ord_test",
      customerName: "Test Customer",
      customerPhone: "+8801700000000",
      customerEmail: "test@example.com",
      shippingAddress: "123 Test Street",
      city: "dhaka",
      zone: "zone",
      area: "area",
      cityName: "Dhaka",
      zoneName: "Zone",
      areaName: "Area",
      notes: null,
      totalAmount: 100,
      shippingCharge: 10,
      discountAmount: 0,
      status: "pending",
      paymentMethod: "cod",
      paymentStatus: "pending",
      paidAmount: 0,
      balanceDue: 100,
      fulfillmentStatus: "pending",
      inventoryPool: "regular",
      inventoryAction: "reserve",
    },
    items: [],
    discountUsage: null,
    ...overrides,
  } as OrderIngestQueueMessage;

  return {
    id: "msg_test",
    timestamp: new Date("2026-01-01T00:00:00Z"),
    attempts: 2,
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function createBatch(messages: Array<Message<OrderIngestQueueMessage>>): MessageBatch<OrderIngestQueueMessage> {
  return {
    queue: "order-ingest-queue",
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  };
}

function createStatementDb(batch: () => Promise<unknown> = vi.fn().mockResolvedValue([])) {
  return {
    insert: vi.fn(() => ({ values: vi.fn(() => ({ statement: "insert" })) })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => ({ statement: "update" })) })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => {
        const query = {
          where: vi.fn(() => ({
            all: vi.fn().mockResolvedValue([]),
            get: vi.fn().mockResolvedValue(undefined),
          })),
        };
        return {
          ...query,
          innerJoin: vi.fn(() => query),
        };
      }),
    })),
    batch,
  };
}

describe("order ingest queue reservation grouping", () => {
  it("groups rollback entries by original order id", () => {
    const entries: QueuedReservationEntry[] = [
      { orderId: "ord_1", variantId: "var_a", quantity: 1, pool: "regular" },
      { orderId: "ord_2", variantId: "var_b", quantity: 2, pool: "preorder" },
      { orderId: "ord_1", variantId: "var_c", quantity: 3, pool: "regular" },
    ];

    expect([...groupReservationEntriesByOrder(entries).entries()]).toEqual([
      [
        "ord_1",
        [
          { orderId: "ord_1", variantId: "var_a", quantity: 1, pool: "regular" },
          { orderId: "ord_1", variantId: "var_c", quantity: 3, pool: "regular" },
        ],
      ],
      [
        "ord_2",
        [
          { orderId: "ord_2", variantId: "var_b", quantity: 2, pool: "preorder" },
        ],
      ],
    ]);
  });
});

describe("order ingest queue checkout retry status", () => {
  it("writes retry metadata without marking checkout status failed", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000);
    const env = createEnv({ orderId: "ord_test" });
    const msg = createOrderIngestMessage();

    await setCheckoutRetryStatus(env, msg, "D1 is busy", 15);

    expect(env.CACHE.put).toHaveBeenCalledOnce();
    const [, value, options] = vi.mocked(env.CACHE.put).mock.calls[0]!;
    expect(JSON.parse(String(value))).toEqual({
      orderId: "ord_test",
      status: "processing",
      retrying: true,
      attempt: 2,
      lastError: "D1 is busy",
      nextRetryAt: 1_815_000,
      updatedAt: 1_800_000,
    });
    expect(options).toEqual({ expirationTtl: 86400 });
  });

  it("keeps prep failures in processing status when the message is retried", async () => {
    vi.spyOn(Date, "now").mockReturnValue(2_000_000);
    const env = createEnv({ orderId: "ord_test" });
    const msg = createOrderIngestMessage({ existingCustomer: undefined });
    const db = createStatementDb();
    db.insert.mockImplementation(() => {
      throw new Error("prepare failed");
    });

    await handleOrderIngestBatch(createBatch([msg]), db as never, env);

    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(msg.ack).not.toHaveBeenCalled();
    const [, value] = vi.mocked(env.CACHE.put).mock.calls.at(-1)!;
    expect(JSON.parse(String(value))).toMatchObject({
      orderId: "ord_test",
      status: "processing",
      retrying: true,
      attempt: 2,
      lastError: "Error: prepare failed",
      nextRetryAt: 2_030_000,
    });
  });

  it("keeps DB batch failures in processing status when the message is retried", async () => {
    vi.spyOn(Date, "now").mockReturnValue(3_000_000);
    const env = createEnv({ orderId: "ord_test" });
    const msg = createOrderIngestMessage();
    const db = createStatementDb(vi.fn().mockRejectedValue(new Error("D1 busy")));

    await handleOrderIngestBatch(createBatch([msg]), db as never, env);

    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 15 });
    expect(msg.ack).not.toHaveBeenCalled();
    const [, value] = vi.mocked(env.CACHE.put).mock.calls.at(-1)!;
    expect(JSON.parse(String(value))).toMatchObject({
      orderId: "ord_test",
      status: "processing",
      retrying: true,
      attempt: 2,
      lastError: "Database write error during heavy traffic. Retrying.",
      nextRetryAt: 3_015_000,
    });
  });

  it("keeps inventory reservation failures in processing status when the batch is retried", async () => {
    vi.spyOn(Date, "now").mockReturnValue(4_000_000);
    const env = createEnv({ orderId: "ord_test" });
    const msg = createOrderIngestMessage({
      items: [{
        productId: "prod_test",
        variantId: "var_missing",
        quantity: 1,
        price: 100,
        productName: "Test Product",
        variantLabel: "Default",
      }],
    });
    const db = createStatementDb();

    await handleOrderIngestBatch(createBatch([msg]), db as never, env);

    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 15 });
    expect(msg.ack).not.toHaveBeenCalled();
    const [, value] = vi.mocked(env.CACHE.put).mock.calls.at(-1)!;
    expect(JSON.parse(String(value))).toMatchObject({
      orderId: "ord_test",
      status: "processing",
      retrying: true,
      attempt: 2,
      lastError: "Insufficient stock preventing batch ingestion.",
      nextRetryAt: 4_015_000,
    });
  });
});
