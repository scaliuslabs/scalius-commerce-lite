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

import {
  reconcileDueRefundAttempts,
  reconcileRefundAttemptById,
  reconcileRefundAttemptForOrder,
  reconcileStripeExternalRefundWebhooks,
} from "./refund-reconciliation";

type SelectResult = unknown[] | Record<string, unknown> | undefined;

function attemptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "rfa_1",
    refundGroupId: "refund_order_1_3",
    orderId: "order_1",
    refundPaymentId: "refund_1",
    gateway: "stripe",
    amount: 25,
    currency: "BDT",
    status: "provider_unknown",
    sourcePaymentId: "pay_1",
    sourceTransactionId: "ch_1",
    providerRefundId: "re_1",
    providerIdempotencyKey: "idem_1",
    refundReference: "ref_1",
    ...overrides,
  };
}

function legacyCurrencyPreflightRows(): SelectResult[] {
  return [
    { currencyCode: null, currencyDecimalPlaces: null },
    [
      { id: "pay_1", currency: "BDT", metadata: null },
      { id: "refund_1", currency: "BDT", metadata: null },
    ],
  ];
}

function createDbMock(selectResults: SelectResult[], returningResults: unknown[][] = [[{ id: "rfa_1" }]]) {
  const selectQueue = [...selectResults];
  const returningQueue = [...returningResults];
  const updateSets: Array<Record<string, unknown>> = [];
  const insertValues: Array<Record<string, unknown>> = [];

  const db = {
    select: vi.fn(() => ({
      from: () => ({
        innerJoin: () => ({
          where: async () => selectQueue.shift() ?? [],
        }),
        where: () => ({
          orderBy: () => ({
            limit: async () => selectQueue.shift() ?? [],
          }),
          get: async () => selectQueue.shift(),
          all: async () => {
            const result = selectQueue.shift();
            return Array.isArray(result) ? result : result ? [result] : [];
          },
        }),
      }),
    })),
    insert: vi.fn(() => ({
      values: (values: Record<string, unknown>) => {
        insertValues.push(values);
        return { values };
      },
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

  return { db: db as unknown as Database, rawDb: db, updateSets, insertValues };
}

describe("refund attempt reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStripeSettings.mockResolvedValue({ secretKey: "sk_test" });
    mocks.getPolarSettings.mockResolvedValue({ accessToken: "polar_test" });
    mocks.finalizeAcceptedRefundAttemptIds.mockResolvedValue({
      orderIds: ["order_1"],
      finalizedAttemptIds: ["rfa_1"],
      refundNotifications: [{
        orderId: "order_1",
        notificationType: "order_partially_refunded",
        dedupeKey: "refund-reconcile:order_1:rfa_1:partial",
        amount: 25,
        refundId: "re_1",
      }],
    });
  });

  it("claims due reconcile-required attempts and finalizes them locally without a provider probe", async () => {
    const { db, updateSets } = createDbMock([
      [{ id: "rfa_1" }],
      attemptRow({ status: "reconcile_required", providerRefundId: "re_1" }),
      ...legacyCurrencyPreflightRows(),
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
      refundNotifications: [{
        orderId: "order_1",
        notificationType: "order_partially_refunded",
        dedupeKey: "refund-reconcile:order_1:rfa_1:partial",
        amount: 25,
        refundId: "re_1",
      }],
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
      ...legacyCurrencyPreflightRows(),
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

  it.each([
    ["amount", { amount: 2499, currency: "bdt", charge: "ch_1" }, "Stripe refund amount does not match"],
    ["currency", { amount: 2500, currency: "usd", charge: "ch_1" }, "Stripe refund currency does not match"],
    ["source", { amount: 2500, currency: "bdt", charge: "ch_other" }, "Stripe refund source charge does not match"],
  ] as const)("does not finalize a Stripe refund with the wrong provider %s", async (_case, provider, error) => {
    mocks.retrieveStripeRefund.mockResolvedValue({
      success: true,
      refund: {
        id: "re_1",
        status: "succeeded",
        amount: provider.amount,
        currency: provider.currency,
        charge: provider.charge,
      },
    });
    const { db, updateSets } = createDbMock([
      [{ id: "rfa_1" }],
      attemptRow(),
      ...legacyCurrencyPreflightRows(),
    ]);

    const result = await reconcileDueRefundAttempts(db, undefined, {
      encryptionKey: "cred_key",
      nowSeconds: 1_765_000_000,
      limit: 5,
    });

    expect(result).toMatchObject({ claimed: 1, finalized: 0, deferred: 1 });
    expect(mocks.finalizeAcceptedRefundAttemptIds).not.toHaveBeenCalled();
    expect(updateSets.at(-1)).toMatchObject({
      status: "provider_unknown",
      lastError: expect.stringContaining(error),
    });
  });

  it("finalizes a converted Polar refund only when provider USD money matches the source-payment snapshot", async () => {
    mocks.listPolarRefunds.mockResolvedValue({
      success: true,
      refunds: [{
        id: "polar_refund_1",
        status: "succeeded",
        amount: 1000,
        currency: "usd",
        orderId: "polar_order_1",
        metadata: {},
      }],
    });
    const sourceMetadata = JSON.stringify({
      originalCurrency: "bdt",
      gatewayCurrency: "usd",
      exchangeRate: "110",
      originalAmount: "1100",
      gatewayAmount: 10,
    });
    const { db } = createDbMock([
      [{ id: "rfa_1" }],
      attemptRow({
        gateway: "polar",
        amount: 1100,
        sourcePaymentId: "pay_polar",
        sourceTransactionId: "polar_order_1",
        providerRefundId: "polar_refund_1",
      }),
      { currencyCode: "BDT", currencyDecimalPlaces: 2 },
      [
        { id: "pay_polar", amount: 1100, currency: "BDT", metadata: sourceMetadata },
        { id: "refund_1", currency: "BDT", metadata: null },
      ],
    ]);

    const result = await reconcileDueRefundAttempts(db, undefined, {
      encryptionKey: "cred_key",
      nowSeconds: 1_765_000_000,
      limit: 5,
    });

    expect(result).toMatchObject({ claimed: 1, finalized: 1, deferred: 0 });
    expect(mocks.finalizeAcceptedRefundAttemptIds).toHaveBeenCalledWith(db, ["rfa_1"]);
  });

  it.each([
    ["amount", { amount: 999, currency: "usd", orderId: "polar_order_1" }, "Polar refund amount does not match"],
    ["currency", { amount: 1000, currency: "bdt", orderId: "polar_order_1" }, "Polar refund currency does not match"],
    ["source", { amount: 1000, currency: "usd", orderId: "polar_order_other" }, "Polar refund source order does not match"],
  ] as const)("does not finalize a converted Polar refund with the wrong provider %s", async (_case, provider, error) => {
    mocks.listPolarRefunds.mockResolvedValue({
      success: true,
      refunds: [{
        id: "polar_refund_1",
        status: "succeeded",
        amount: provider.amount,
        currency: provider.currency,
        orderId: provider.orderId,
        metadata: {},
      }],
    });
    const { db, updateSets } = createDbMock([
      [{ id: "rfa_1" }],
      attemptRow({
        gateway: "polar",
        amount: 1100,
        sourcePaymentId: "pay_polar",
        sourceTransactionId: "polar_order_1",
        providerRefundId: "polar_refund_1",
      }),
      { currencyCode: "BDT", currencyDecimalPlaces: 2 },
      [
        {
          id: "pay_polar",
          amount: 1100,
          currency: "BDT",
          metadata: JSON.stringify({
            originalCurrency: "bdt",
            gatewayCurrency: "usd",
            exchangeRate: "110",
            originalAmount: "1100",
            gatewayAmount: 10,
          }),
        },
        { id: "refund_1", currency: "BDT", metadata: null },
      ],
    ]);

    const result = await reconcileDueRefundAttempts(db, undefined, {
      encryptionKey: "cred_key",
      nowSeconds: 1_765_000_000,
      limit: 5,
    });

    expect(result).toMatchObject({ claimed: 1, finalized: 0, deferred: 1 });
    expect(mocks.finalizeAcceptedRefundAttemptIds).not.toHaveBeenCalled();
    expect(updateSets.at(-1)).toMatchObject({
      status: "provider_unknown",
      lastError: expect.stringContaining(error),
    });
  });

  it("returns one buyer-safe processing notification when the provider still has the refund pending", async () => {
    mocks.retrieveStripeRefund.mockResolvedValue({
      success: true,
      refund: {
        id: "re_pending",
        status: "pending",
        amount: 2500,
        currency: "bdt",
        charge: "ch_1",
      },
    });
    const { db, updateSets } = createDbMock([
      [{ id: "rfa_1" }],
      attemptRow(),
      ...legacyCurrencyPreflightRows(),
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
      refundNotifications: [{
        orderId: "order_1",
        notificationType: "refund_processing",
        dedupeKey: "refund:order_1:refund_order_1_3:processing",
        amount: 25,
        refundId: "re_pending",
      }],
    });
    expect(mocks.finalizeAcceptedRefundAttemptIds).not.toHaveBeenCalled();
    expect(updateSets.at(-1)).toMatchObject({
      status: "provider_unknown",
      providerStatus: "pending",
      providerRefundId: "re_pending",
      lastError: null,
    });
  });

  it("returns one buyer-safe failed notification after the provider rejects a refund", async () => {
    mocks.retrieveStripeRefund.mockResolvedValue({
      success: true,
      refund: {
        id: "re_failed",
        status: "failed",
        amount: 2500,
        currency: "bdt",
        charge: "ch_1",
      },
    });
    const { db, updateSets } = createDbMock([
      [{ id: "rfa_1" }],
      attemptRow(),
      ...legacyCurrencyPreflightRows(),
    ]);

    const result = await reconcileDueRefundAttempts(db, undefined, {
      encryptionKey: "cred_key",
      nowSeconds: 1_765_000_000,
      limit: 5,
    });

    expect(result).toMatchObject({
      claimed: 1,
      finalized: 0,
      failed: 1,
      deferred: 0,
      refundNotifications: [{
        orderId: "order_1",
        notificationType: "refund_failed",
        dedupeKey: "refund:order_1:refund_order_1_3:failed",
        amount: 25,
        refundId: "re_failed",
      }],
    });
    expect(mocks.finalizeAcceptedRefundAttemptIds).not.toHaveBeenCalled();
    expect(updateSets.at(-1)).toMatchObject({
      status: "failed",
      providerStatus: "failed",
      providerRefundId: "re_failed",
    });
  });

  it("lets an admin force-check a provider-unknown attempt before its next scheduled probe", async () => {
    mocks.retrieveStripeRefund.mockResolvedValue({
      success: true,
      refund: {
        id: "re_1",
        status: "succeeded",
        amount: 2500,
        currency: "bdt",
        charge: "ch_1",
      },
    });
    const { db, updateSets } = createDbMock([
      {
        id: "rfa_1",
        orderId: "order_1",
        status: "provider_unknown",
        claimExpiresAt: null,
        nextProbeAt: 1_765_000_900,
      },
      attemptRow({ nextProbeAt: 1_765_000_900 }),
      ...legacyCurrencyPreflightRows(),
    ]);

    const result = await reconcileRefundAttemptForOrder(
      db,
      undefined,
      "order_1",
      "rfa_1",
      {
        encryptionKey: "cred_key",
        nowSeconds: 1_765_000_000,
      },
    );

    expect(result).toMatchObject({
      found: true,
      status: "finalized",
      orderIds: ["order_1"],
    });
    expect(updateSets[0]).toMatchObject({
      claimId: "refund_reconcile:rfa_1:1765000000",
      claimExpiresAt: 1_765_000_300,
    });
    expect(mocks.retrieveStripeRefund).toHaveBeenCalledWith("sk_test", "re_1");
  });

  it("does not manually fail a fresh pending attempt before it is due", async () => {
    const { db, rawDb } = createDbMock([
      {
        id: "rfa_1",
        orderId: "order_1",
        status: "pending",
        claimExpiresAt: null,
        nextProbeAt: 1_765_000_900,
      },
    ]);

    const result = await reconcileRefundAttemptForOrder(
      db,
      undefined,
      "order_1",
      "rfa_1",
      { nowSeconds: 1_765_000_000 },
    );

    expect(result).toMatchObject({
      found: true,
      status: "deferred",
      reason: "pending_not_due",
    });
    expect(rawDb.update).not.toHaveBeenCalled();
    expect(mocks.finalizeAcceptedRefundAttemptIds).not.toHaveBeenCalled();
  });

  it("preflights the full payment ledger before failing an expired pending attempt", async () => {
    const { db, rawDb } = createDbMock([
      attemptRow({ status: "pending", currency: "KWD" }),
      { currencyCode: "KWD", currencyDecimalPlaces: 3 },
      [{ id: "refund_1", currency: "BDT" }],
    ]);

    await expect(reconcileRefundAttemptById(db, undefined, "rfa_1", {
      nowSeconds: 1_765_000_000,
    })).rejects.toThrow("currency does not match");

    expect(rawDb.update).not.toHaveBeenCalled();
    expect(mocks.finalizeAcceptedRefundAttemptIds).not.toHaveBeenCalled();
  });

  it("honors an active reconciliation lease for manual checks", async () => {
    const { db, rawDb } = createDbMock([
      {
        id: "rfa_1",
        orderId: "order_1",
        status: "provider_unknown",
        claimExpiresAt: 1_765_000_100,
        nextProbeAt: 1_765_000_000,
      },
    ]);

    const result = await reconcileRefundAttemptForOrder(
      db,
      undefined,
      "order_1",
      "rfa_1",
      { nowSeconds: 1_765_000_000 },
    );

    expect(result).toMatchObject({
      found: true,
      status: "deferred",
      reason: "leased",
    });
    expect(rawDb.update).not.toHaveBeenCalled();
  });

  it("imports a KWD Stripe dashboard refund using immutable source capacity and three-decimal minors", async () => {
    mocks.listStripeRefundsForCharge.mockResolvedValue({
      success: true,
      refunds: [{
        id: "re_dash_1",
        status: "succeeded",
        amount: 1235,
        currency: "kwd",
        charge: "ch_1",
        metadata: {},
      }],
    });
    mocks.finalizeAcceptedRefundAttemptIds.mockResolvedValue({
      orderIds: ["order_1"],
      finalizedAttemptIds: ["rfa_stripe_external_re_dash_1"],
      refundNotifications: [{
        orderId: "order_1",
        notificationType: "order_partially_refunded",
        dedupeKey: "refund-reconcile:order_1:rfa_stripe_external_re_dash_1:partial",
        amount: 1.235,
        refundId: "re_dash_1",
      }],
    });
    const { db, rawDb, insertValues, updateSets } = createDbMock([
      [{
        id: "stripe:charge-refunded:evt_refund",
        orderId: "order_1",
        result: JSON.stringify({
          chargeId: "ch_1",
          paymentIntentId: "pi_1",
          amountRefunded: 1235,
          currency: "kwd",
        }),
      }],
      {
        id: "pay_1",
        orderId: "order_1",
        amount: 2.469,
        currency: "KWD",
        stripePaymentIntentId: "pi_1",
        stripeChargeId: "ch_1",
      },
      { currencyCode: "KWD", currencyDecimalPlaces: 3 },
      undefined,
      [{ amount: 1.234, currency: "KWD" }],
    ]);

    const result = await reconcileStripeExternalRefundWebhooks(db, undefined, {
      encryptionKey: "cred_key",
      nowSeconds: 1_765_000_000,
      limit: 5,
    });

    expect(mocks.getStripeSettings).toHaveBeenCalledWith(db, undefined, "cred_key", { bypassMemoryCache: true });
    expect(mocks.listStripeRefundsForCharge).toHaveBeenCalledWith("sk_test", "ch_1", 100);
    expect(rawDb.batch).toHaveBeenCalledTimes(1);
    expect(insertValues[0]).toMatchObject({
      id: "refund_stripe_external_re_dash_1",
      orderId: "order_1",
      amount: 1.235,
      currency: "KWD",
      paymentMethod: "stripe",
      paymentType: "refund",
      status: "pending",
      stripePaymentIntentId: "pi_1",
      stripeChargeId: "ch_1",
    });
    expect(insertValues[1]).toMatchObject({
      id: "rfa_stripe_external_re_dash_1",
      attemptKey: "external:stripe:re_dash_1",
      refundGroupId: "stripe_external_order_1_re_dash_1",
      orderId: "order_1",
      sourcePaymentId: "pay_1",
      refundPaymentId: "refund_stripe_external_re_dash_1",
      gateway: "stripe",
      amount: 1.235,
      providerRefundId: "re_dash_1",
      providerStatus: "succeeded",
      status: "reconcile_required",
    });
    expect(mocks.finalizeAcceptedRefundAttemptIds).toHaveBeenCalledWith(db, ["rfa_stripe_external_re_dash_1"]);
    expect(updateSets.at(-1)).toMatchObject({
      status: "processed",
    });
    expect(JSON.parse(String(updateSets.at(-1)?.result))).toMatchObject({
      stripeExternalRefundReconciliation: {
        outcome: "external_refund_reconciled",
        importedRefundIds: ["re_dash_1"],
        providerRefundIds: ["re_dash_1"],
        imported: 1,
        finalized: 1,
        deferred: 0,
      },
    });
    expect(result).toMatchObject({
      scanned: 1,
      imported: 1,
      finalized: 1,
      skipped: 0,
      deferred: 0,
      finalizedOrderIds: ["order_1"],
      refundNotifications: [{
        orderId: "order_1",
        notificationType: "order_partially_refunded",
        amount: 1.235,
        refundId: "re_dash_1",
      }],
    });
  });
});
