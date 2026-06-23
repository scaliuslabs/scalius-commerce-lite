import { describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import {
  buildPaymentSessionAttemptIdentity,
  claimPaymentSessionAttempt,
  markPaymentSessionAttemptCreated,
  markPaymentSessionAttemptFailed,
} from "./payment-session-attempts";

type AttemptRow = {
  id: string;
  attemptKey: string;
  orderId: string;
  gateway: string;
  paymentType: string;
  amount: number;
  currency: string;
  requestHash: string;
  status: string;
  providerSessionId: string | null;
  providerCorrelationId: string | null;
  responsePayload: string | null;
  attempts: number;
  claimId: string | null;
  claimExpiresAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};

describe("payment session attempts", () => {
  it("replays a created attempt without creating a second claim", async () => {
    const fake = createFakePaymentSessionDb();
    const identity = await buildIdentity();

    const first = await claimPaymentSessionAttempt<{ paymentIntentId: string }>(fake.db, identity);
    expect(first.status).toBe("claimed");
    if (first.status !== "claimed") throw new Error("expected first claim");

    await markPaymentSessionAttemptCreated(fake.db, first.attempt, {
      providerSessionId: "pi_1",
      response: { paymentIntentId: "pi_1" },
    });

    const second = await claimPaymentSessionAttempt<{ paymentIntentId: string }>(fake.db, identity);

    expect(second).toEqual({
      status: "replay",
      response: { paymentIntentId: "pi_1" },
    });
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]?.attempts).toBe(1);
  });

  it("returns a processing state for duplicate claims while the first attempt is still processing", async () => {
    const fake = createFakePaymentSessionDb();
    const identity = await buildIdentity();

    await claimPaymentSessionAttempt(fake.db, identity);

    await expect(claimPaymentSessionAttempt(fake.db, identity)).resolves.toEqual({
      status: "processing",
      retryable: true,
      retryAfterSeconds: 2,
      orderId: "order_1",
      gateway: "stripe",
      paymentType: "full",
      message: "Payment session creation is already processing. Please try again shortly.",
    });
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]?.attempts).toBe(1);
  });

  it("returns a processing state for the same order/gateway/payment type even when the attempt key differs", async () => {
    const fake = createFakePaymentSessionDb();
    const firstIdentity = await buildIdentity({ retryKey: "first" });
    const secondIdentity = await buildIdentity({ retryKey: "second" });

    await claimPaymentSessionAttempt(fake.db, firstIdentity);

    await expect(claimPaymentSessionAttempt(fake.db, secondIdentity)).resolves.toEqual({
      status: "processing",
      retryable: true,
      retryAfterSeconds: 2,
      orderId: "order_1",
      gateway: "stripe",
      paymentType: "full",
      message: "Payment session creation is already processing. Please try again shortly.",
    });
    expect(firstIdentity.attemptKey).not.toBe(secondIdentity.attemptKey);
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]?.attemptKey).toBe(firstIdentity.attemptKey);
    expect(fake.rows[0]?.attempts).toBe(1);
  });

  it("reclaims failed attempts with the same canonical attempt key", async () => {
    const fake = createFakePaymentSessionDb();
    const identity = await buildIdentity();

    const first = await claimPaymentSessionAttempt(fake.db, identity);
    if (first.status !== "claimed") throw new Error("expected first claim");
    await markPaymentSessionAttemptFailed(fake.db, first.attempt, new Error("provider unavailable"));

    const second = await claimPaymentSessionAttempt(fake.db, identity);

    expect(second.status).toBe("claimed");
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]?.status).toBe("processing");
    expect(fake.rows[0]?.attempts).toBe(2);
    expect(fake.rows[0]?.lastError).toBeNull();
  });

  it("reclaims stale same-order processing attempts even when the attempt key differs", async () => {
    const fake = createFakePaymentSessionDb();
    const firstIdentity = await buildIdentity({ retryKey: "first" });
    const secondIdentity = await buildIdentity({ retryKey: "second" });

    await claimPaymentSessionAttempt(fake.db, firstIdentity);
    if (!fake.rows[0]) throw new Error("expected first row");
    fake.rows[0].claimExpiresAt = Math.floor(Date.now() / 1000) - 1;

    const second = await claimPaymentSessionAttempt(fake.db, secondIdentity);

    expect(second.status).toBe("claimed");
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]?.attemptKey).toBe(secondIdentity.attemptKey);
    expect(fake.rows[0]?.requestHash).toBe(secondIdentity.requestHash);
    expect(fake.rows[0]?.status).toBe("processing");
    expect(fake.rows[0]?.attempts).toBe(2);
  });

  it("returns processing when an old failed exact attempt races with a newer live attempt", async () => {
    const fake = createFakePaymentSessionDb();
    const firstIdentity = await buildIdentity({ retryKey: "first" });
    const secondIdentity = await buildIdentity({ retryKey: "second" });

    const first = await claimPaymentSessionAttempt(fake.db, firstIdentity);
    if (first.status !== "claimed") throw new Error("expected first claim");
    await markPaymentSessionAttemptFailed(fake.db, first.attempt, new Error("provider timeout"));
    await claimPaymentSessionAttempt(fake.db, secondIdentity);

    const retryFirst = await claimPaymentSessionAttempt(fake.db, firstIdentity);

    expect(retryFirst).toEqual({
      status: "processing",
      retryable: true,
      retryAfterSeconds: 2,
      orderId: "order_1",
      gateway: "stripe",
      paymentType: "full",
      message: "Payment session creation is already processing. Please try again shortly.",
    });
    expect(fake.rows).toHaveLength(2);
    expect(fake.rows[0]?.attemptKey).toBe(firstIdentity.attemptKey);
    expect(fake.rows[0]?.status).toBe("failed");
    expect(fake.rows[1]?.attemptKey).toBe(secondIdentity.attemptKey);
    expect(fake.rows[1]?.status).toBe("processing");
  });

  it("clears stale competing live attempts before reclaiming an old failed exact attempt", async () => {
    const fake = createFakePaymentSessionDb();
    const firstIdentity = await buildIdentity({ retryKey: "first" });
    const secondIdentity = await buildIdentity({ retryKey: "second" });

    const first = await claimPaymentSessionAttempt(fake.db, firstIdentity);
    if (first.status !== "claimed") throw new Error("expected first claim");
    await markPaymentSessionAttemptFailed(fake.db, first.attempt, new Error("provider timeout"));
    await claimPaymentSessionAttempt(fake.db, secondIdentity);
    if (!fake.rows[1]) throw new Error("expected second row");
    fake.rows[1].claimExpiresAt = Math.floor(Date.now() / 1000) - 1;

    const retryFirst = await claimPaymentSessionAttempt(fake.db, firstIdentity);

    expect(retryFirst.status).toBe("claimed");
    expect(fake.rows).toHaveLength(2);
    expect(fake.rows[0]?.attemptKey).toBe(firstIdentity.attemptKey);
    expect(fake.rows[0]?.status).toBe("processing");
    expect(fake.rows[0]?.attempts).toBe(2);
    expect(fake.rows[1]?.attemptKey).toBe(secondIdentity.attemptKey);
    expect(fake.rows[1]?.status).toBe("failed");
    expect(fake.rows[1]?.lastError).toBe("Superseded by a newer payment session single-flight claim.");
  });

  it("builds stable customer-account proof keys without colliding with receipt-token attempts", async () => {
    const receiptIdentity = await buildIdentity();
    const accountIdentity = await buildPaymentSessionAttemptIdentity({
      orderId: "order_1",
      gateway: "stripe",
      paymentType: "full",
      amount: 125,
      currency: "BDT",
      proof: { kind: "customer_account", value: "customer_1" },
      requestContext: {
        amountInSmallestUnit: 12500,
        manualCapture: false,
      },
    });
    const repeatedAccountIdentity = await buildPaymentSessionAttemptIdentity({
      orderId: "order_1",
      gateway: "stripe",
      paymentType: "full",
      amount: 125,
      currency: "BDT",
      proof: { kind: "customer_account", value: "customer_1" },
      requestContext: {
        amountInSmallestUnit: 12500,
        manualCapture: false,
      },
    });

    expect(accountIdentity.attemptKey).toBe(repeatedAccountIdentity.attemptKey);
    expect(accountIdentity.attemptKey).not.toBe(receiptIdentity.attemptKey);
  });
});

async function buildIdentity(requestContext: Record<string, unknown> = {
  amountInSmallestUnit: 12500,
  manualCapture: false,
}) {
  return await buildPaymentSessionAttemptIdentity({
    orderId: "order_1",
    gateway: "stripe",
    paymentType: "full",
    amount: 125,
    currency: "BDT",
    receiptToken: "receipt_1",
    requestContext,
  });
}

function createFakePaymentSessionDb(): { db: Database; rows: AttemptRow[] } {
  const rows: AttemptRow[] = [];
  const now = () => Math.floor(Date.now() / 1000);
  let exactReadsToSkipAfterLiveConflict = 0;
  let exactUpdatesToSkipAfterLiveConflict = 0;
  let exactConflictAttemptKey: string | null = null;
  let exactConflictSelectCount = 0;

  const db = {
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (rows.some((row) => row.attemptKey === values.attemptKey)) {
              exactConflictAttemptKey = String(values.attemptKey);
              exactConflictSelectCount = 0;
              return [];
            }
            if (rows.some((row) =>
              row.status === "processing" &&
              row.orderId === values.orderId &&
              row.gateway === values.gateway &&
              row.paymentType === values.paymentType
            )) {
              exactReadsToSkipAfterLiveConflict = 2;
              exactUpdatesToSkipAfterLiveConflict = 1;
              return [];
            }
            const createdAt = now();
            const row: AttemptRow = {
              id: String(values.id),
              attemptKey: String(values.attemptKey),
              orderId: String(values.orderId),
              gateway: String(values.gateway),
              paymentType: String(values.paymentType),
              amount: Number(values.amount),
              currency: String(values.currency),
              requestHash: String(values.requestHash),
              status: String(values.status),
              providerSessionId: (values.providerSessionId as string | null | undefined) ?? null,
              providerCorrelationId: (values.providerCorrelationId as string | null | undefined) ?? null,
              responsePayload: (values.responsePayload as string | null | undefined) ?? null,
              attempts: Number(values.attempts ?? 0),
              claimId: (values.claimId as string | null | undefined) ?? null,
              claimExpiresAt: createdAt + 300,
              lastError: (values.lastError as string | null | undefined) ?? null,
              createdAt,
              updatedAt: createdAt,
            };
            rows.push(row);
            return [{
              id: row.id,
              attemptKey: row.attemptKey,
              providerCorrelationId: row.providerCorrelationId,
            }];
          },
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          get: async () => {
            if (exactReadsToSkipAfterLiveConflict > 0) {
              exactReadsToSkipAfterLiveConflict -= 1;
              return undefined;
            }
            if (exactConflictAttemptKey) {
              exactConflictSelectCount += 1;
              const exact = rows.find((row) => row.attemptKey === exactConflictAttemptKey);
              if (exactConflictSelectCount === 1 || exactConflictSelectCount >= 3) return exact;
              return rows.find((row) =>
                row.status === "processing" &&
                row.orderId === exact?.orderId &&
                row.gateway === exact?.gateway &&
                row.paymentType === exact?.paymentType
              );
            }
            return rows[0];
          },
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (condition: unknown) => {
          const applyUpdate = () => {
            const row = resolveUpdateTarget(rows, values, exactConflictAttemptKey);
            if (!row) return [];
            if (exactUpdatesToSkipAfterLiveConflict > 0 && !Object.hasOwn(values, "attemptKey")) {
              exactUpdatesToSkipAfterLiveConflict -= 1;
              return [];
            }
            if (values.status === "processing" && row.status === "processing" && (row.claimExpiresAt ?? 0) > now()) {
              return [];
            }
            Object.assign(row, materializeUpdate(values, row));
            if (values.status === "processing" || Object.hasOwn(values, "attemptKey")) {
              exactConflictAttemptKey = null;
              exactConflictSelectCount = 0;
            }
            return [{ id: row.id, attemptKey: row.attemptKey, providerCorrelationId: row.providerCorrelationId }];
          };
          const query = {
            returning: async () => applyUpdate(),
            then: (resolve: (value: unknown) => void) => resolve(condition ? applyUpdate() : []),
          };
          return query;
        },
      }),
    }),
  } as unknown as Database;

  return { db, rows };
}

function resolveUpdateTarget(
  rows: AttemptRow[],
  values: Record<string, unknown>,
  exactConflictAttemptKey: string | null,
): AttemptRow | undefined {
  if (
    exactConflictAttemptKey &&
    values.status === "failed" &&
    values.claimId === null &&
    values.claimExpiresAt === null
  ) {
    return rows.find((row) => row.status === "processing" && row.attemptKey !== exactConflictAttemptKey) ??
      rows.find((row) => row.attemptKey === exactConflictAttemptKey) ??
      rows[0];
  }

  if (Object.hasOwn(values, "attemptKey")) {
    return rows.find((row) => row.status === "processing") ?? rows[0];
  }

  if (exactConflictAttemptKey) {
    return rows.find((row) => row.attemptKey === exactConflictAttemptKey) ?? rows[0];
  }

  return rows[0];
}

function materializeUpdate(values: Record<string, unknown>, row: AttemptRow): Partial<AttemptRow> {
  const next: Partial<AttemptRow> = {};
  for (const [key, value] of Object.entries(values)) {
    if (key === "attempts") {
      next.attempts = row.attempts + 1;
    } else if (key === "claimExpiresAt") {
      next.claimExpiresAt = value === null ? null : Math.floor(Date.now() / 1000) + 300;
    } else if (key === "updatedAt") {
      next.updatedAt = Math.floor(Date.now() / 1000);
    } else {
      (next as Record<string, unknown>)[key] = value;
    }
  }
  return next;
}
