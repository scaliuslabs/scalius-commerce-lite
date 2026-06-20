import { describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { ConflictError } from "@scalius/core/errors";
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

  it("rejects duplicate claims while the first attempt is still processing", async () => {
    const fake = createFakePaymentSessionDb();
    const identity = await buildIdentity();

    await claimPaymentSessionAttempt(fake.db, identity);

    await expect(claimPaymentSessionAttempt(fake.db, identity)).rejects.toBeInstanceOf(ConflictError);
    expect(fake.rows).toHaveLength(1);
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

async function buildIdentity() {
  return await buildPaymentSessionAttemptIdentity({
    orderId: "order_1",
    gateway: "stripe",
    paymentType: "full",
    amount: 125,
    currency: "BDT",
    receiptToken: "receipt_1",
    requestContext: {
      amountInSmallestUnit: 12500,
      manualCapture: false,
    },
  });
}

function createFakePaymentSessionDb(): { db: Database; rows: AttemptRow[] } {
  const rows: AttemptRow[] = [];
  const now = () => Math.floor(Date.now() / 1000);

  const db = {
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (rows.some((row) => row.attemptKey === values.attemptKey)) return [];
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
          get: async () => rows[0],
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (condition: unknown) => {
          const applyUpdate = () => {
            const row = rows[0];
            if (!row) return [];
            if (values.status === "processing" && row.status === "processing" && (row.claimExpiresAt ?? 0) > now()) {
              return [];
            }
            Object.assign(row, materializeUpdate(values, row));
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
