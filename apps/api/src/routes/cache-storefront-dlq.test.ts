import { OpenAPIHono } from "@hono/zod-openapi";
import type { Database } from "@scalius/database/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listStorefrontCacheQueueFailures: vi.fn(),
  replayStorefrontCacheQueueFailure: vi.fn(),
  ignoreStorefrontCacheQueueFailure: vi.fn(),
}));

vi.mock("../utils/storefront-cache-queue-failures", () => ({
  listStorefrontCacheQueueFailures: mocks.listStorefrontCacheQueueFailures,
  replayStorefrontCacheQueueFailure: mocks.replayStorefrontCacheQueueFailure,
  ignoreStorefrontCacheQueueFailure: mocks.ignoreStorefrontCacheQueueFailure,
}));

import { errorResponseFromError } from "../utils/api-response";
import { cacheControlRoutes } from "./cache";

const failureRecord = {
  id: "scqf_1",
  queueName: "storefront-cache-dlq",
  queueMessageId: "msg-storefront-cache-purge",
  messageType: "storefront.cache_purge",
  operationId: "purge_op_1",
  source: "catalog:products",
  attempts: 6,
  status: "pending",
  lastError: null,
  replayCount: 0,
  messageTimestamp: 1_767_225_600,
  failedAt: 1_790_000_000,
  replayedAt: null,
  replayedBy: null,
  ignoredAt: null,
  ignoredBy: null,
  createdAt: 1_790_000_000,
  updatedAt: 1_790_000_000,
};

const failureDetail = {
  ...failureRecord,
  status: "replayed",
  replayCount: 1,
  replayedAt: 1_790_000_010,
  replayedBy: "admin_1",
  payload: {
    type: "storefront.cache_purge",
    operationId: "purge_op_1",
    groups: ["products"],
    prefixes: ["product_slug_fish"],
    exactKeys: ["product_variants_prod_1"],
    htmlPaths: ["/products/fish"],
    bumpVersion: false,
    source: "catalog:products",
    requestedAt: 1_790_000_000,
  },
};

function createTestApp() {
  const db = { id: "db" } as unknown as Database;
  const user = { id: "admin_1", name: "Admin", email: "admin@example.test" };
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");

  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("user", user);
    await next();
  });

  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.route("/cache", cacheControlRoutes);

  return { app, db, user };
}

describe("storefront cache DLQ routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listStorefrontCacheQueueFailures.mockResolvedValue([failureRecord]);
    mocks.replayStorefrontCacheQueueFailure.mockResolvedValue(failureDetail);
    mocks.ignoreStorefrontCacheQueueFailure.mockResolvedValue({
      ...failureRecord,
      status: "ignored",
      ignoredAt: 1_790_000_020,
      ignoredBy: "admin_1",
    });
  });

  it("lists archived storefront cache queue failures with bounded filters", async () => {
    const { app, db } = createTestApp();

    const response = await app.request("/api/v1/cache/storefront-dlq?status=pending&limit=5");
    const body = await response.json() as {
      success: boolean;
      data?: { failures?: Array<typeof failureRecord> };
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data?.failures).toEqual([failureRecord]);
    expect(mocks.listStorefrontCacheQueueFailures).toHaveBeenCalledWith(db, {
      status: "pending",
      limit: 5,
    });
  });

  it("replays an archived storefront cache queue failure through the queue binding", async () => {
    const { app, db } = createTestApp();
    const queue = { send: vi.fn(async () => undefined) };

    const response = await app.request(
      "/api/v1/cache/storefront-dlq/scqf_1/replay",
      { method: "POST" },
      { STOREFRONT_CACHE_QUEUE: queue } as never,
    );
    const body = await response.json() as {
      success: boolean;
      data?: { message?: string; failure?: typeof failureDetail };
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data?.message).toBe("Storefront cache queue failure replayed.");
    expect(body.data?.failure).toEqual(failureDetail);
    expect(mocks.replayStorefrontCacheQueueFailure).toHaveBeenCalledWith(
      db,
      "scqf_1",
      queue,
      "admin_1",
    );
  });

  it("marks an archived storefront cache queue failure ignored by the admin actor", async () => {
    const { app, db } = createTestApp();

    const response = await app.request(
      "/api/v1/cache/storefront-dlq/scqf_1/ignore",
      { method: "POST" },
    );
    const body = await response.json() as {
      success: boolean;
      data?: { message?: string; failure?: typeof failureRecord };
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data?.message).toBe("Storefront cache queue failure ignored.");
    expect(body.data?.failure?.status).toBe("ignored");
    expect(mocks.ignoreStorefrontCacheQueueFailure).toHaveBeenCalledWith(
      db,
      "scqf_1",
      "admin_1",
    );
  });
});
