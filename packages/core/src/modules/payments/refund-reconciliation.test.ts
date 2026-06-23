import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";

const mocks = vi.hoisted(() => ({
  getStripeSettings: vi.fn(),
  getSSLCommerzSettings: vi.fn(),
  getPolarSettings: vi.fn(),
  retrieveStripeRefund: vi.fn(),
  listStripeRefundsForCharge: vi.fn(),
  querySSLCommerzRefundStatus: vi.fn(),
  listPolarRefunds: vi.fn(),
  finalizeAcceptedRefundAttemptIds: vi.fn(),
}));

vi.mock("./gateway-settings", () => ({
  FRESH_GATEWAY_SETTINGS_READ_OPTIONS: { bypassMemoryCache: true },
  getStripeSettings: mocks.getStripeSettings,
  getSSLCommerzSettings: mocks.getSSLCommerzSettings,
  getPolarSettings: mocks.getPolarSettings,
}));

vi.mock("./stripe", () => ({
  retrieveStripeRefund: mocks.retrieveStripeRefund,
  listStripeRefundsForCharge: mocks.listStripeRefundsForCharge,
}));

vi.mock("./sslcommerz", () => ({
  querySSLCommerzRefundStatus: mocks.querySSLCommerzRefundStatus,
}));

vi.mock("./polar", () => ({
  listPolarRefunds: mocks.listPolarRefunds,
}));

vi.mock("./refund-service", () => ({
  finalizeAcceptedRefundAttemptIds: mocks.finalizeAcceptedRefundAttemptIds,
}));

import { reconcileDueRefundAttempts } from "./refund-reconciliation";

type SelectResult = unknown[] | Record<string, unknown> | undefined;

function attemptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "rfa_1",
    orderId: "order_1",
    refundPaymentId: "refund_1",
    gateway: "stripe",
    amount: 25,
    currency: "BDT",
    status: "provider_unknown",
    sourceTransactionId: "ch_1",
    providerRefundId: "re_1",
    providerIdempotencyKey: "idem_1",
    refundReference: "ref_1",
    ...overrides,
  };
}

function createDbMock(selectResults: SelectResult[], returningResults: unknown[][] = [[{ id: "rfa_1" }]]) {
  const selectQueue = [...selectResults];
  const returningQueue = [...returningResults];
  const updateSets: Array<Record<string, unknown>> = [];

  const db = {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => selectQueue.shift() ?? [],
          }),
          get: async () => selectQueue.shift(),
        }),
      }),
    })),
    update: vi.fn(() => ({
      set: (values: Record<string, unknown>) => {
        updateSets.push(values);
        return {
          where: () => ({
            returning: async () => returningQueue.shift() ?? [],
            then: (resolve: (value?: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
              Promise.resolve(undefined).then(resolve, reject),
          }),
        };
      },
    })),
    batch: vi.fn(async () => []),
  };

  return { db: db as unknown as Database, rawDb: db, updateSets };
}

describe("refund attempt reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStripeSettings.mockResolvedValue({ secretKey: "sk_test" });
    mocks.finalizeAcceptedRefundAttemptIds.mockResolvedValue({
      orderIds: ["order_1"],
      finalizedAttemptIds: ["rfa_1"],
    });
  });

  it("claims due reconcile-required attempts and finalizes them locally without a provider probe", async () => {
    const { db, updateSets } = createDbMock([
      [{ id: "rfa_1" }],
      attemptRow({ status: "reconcile_required", providerRefundId: "re_1" }),
    ]);

    const result = await reconcileDueRefundAttempts(db, undefined, {
      nowSeconds: 1_765_000_000,
      limit: 5,
    });

    expect(result).toMatchObject({
      scanned: 1,
      claimed: 1,
      finalized: 1,
      failed: 0,
      deferred: 0,
      finalizedOrderIds: ["order_1"],
    });
    expect(mocks.retrieveStripeRefund).not.toHaveBeenCalled();
    expect(mocks.finalizeAcceptedRefundAttemptIds).toHaveBeenCalledWith(db, ["rfa_1"]);
    expect(updateSets[0]).toMatchObject({
      claimId: "refund_reconcile:rfa_1:1765000000",
      claimExpiresAt: 1_765_000_300,
    });
  });

  it("does not process a due candidate when another worker wins the claim", async () => {
    const { db } = createDbMock(
      [[{ id: "rfa_1" }]],
      [[]],
    );

    const result = await reconcileDueRefundAttempts(db, undefined, {
      nowSeconds: 1_765_000_000,
      limit: 5,
    });

    expect(result).toMatchObject({
      scanned: 1,
      claimed: 0,
      finalized: 0,
      deferred: 0,
    });
    expect(mocks.finalizeAcceptedRefundAttemptIds).not.toHaveBeenCalled();
  });

  it("keeps provider-unknown attempts active when a Stripe probe fails", async () => {
    mocks.retrieveStripeRefund.mockResolvedValue({
      success: false,
      error: "stripe unavailable",
    });
    const { db, updateSets } = createDbMock([
      [{ id: "rfa_1" }],
      attemptRow(),
    ]);

    const result = await reconcileDueRefundAttempts(db, undefined, {
      encryptionKey: "cred_key",
      nowSeconds: 1_765_000_000,
      limit: 5,
    });

    expect(result).toMatchObject({
      claimed: 1,
      finalized: 0,
      failed: 0,
      deferred: 1,
    });
    expect(mocks.getStripeSettings).toHaveBeenCalledWith(db, undefined, "cred_key", { bypassMemoryCache: true });
    expect(mocks.retrieveStripeRefund).toHaveBeenCalledWith("sk_test", "re_1");
    expect(mocks.finalizeAcceptedRefundAttemptIds).not.toHaveBeenCalled();
    expect(updateSets.at(-1)).toMatchObject({
      status: "provider_unknown",
      claimId: null,
      claimExpiresAt: null,
      lastProbeAt: 1_765_000_000,
      nextProbeAt: 1_765_000_900,
      lastError: "stripe unavailable",
    });
  });
});
