import { describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { checkoutAttempts, orderReceipts } from "@scalius/database/schema";
import {
  hashOrderReceiptToken,
  recordOrderReceipt,
  validateOrderReceiptProof,
} from "./order-receipts";

type ReceiptRow = {
  tokenHash: string;
  orderId: string;
  source: string;
  status: string;
  expiresAt: number;
};

type AttemptRow = {
  orderId: string;
  status: string;
};

function createReceiptDb(options: {
  receipt?: ReceiptRow | null;
  attempt?: AttemptRow | null;
} = {}) {
  const receipts: ReceiptRow[] = options.receipt ? [options.receipt] : [];
  const inserted: ReceiptRow[] = [];

  const db = {
    select: () => {
      let selectedTable: unknown;
      const query = {
        from: (table: unknown) => {
          selectedTable = table;
          return query;
        },
        where: () => query,
        get: async () => {
          if (selectedTable === orderReceipts) return receipts[0] ?? null;
          if (selectedTable === checkoutAttempts) return options.attempt ?? null;
          return null;
        },
      };
      return query;
    },
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: async () => {
          if (table !== orderReceipts) return;
          const row: ReceiptRow = {
            tokenHash: String(values.tokenHash),
            orderId: String(values.orderId),
            source: String(values.source),
            status: String(values.status),
            expiresAt: Number(values.expiresAt),
          };
          inserted.push(row);
          receipts[0] = row;
        },
      }),
    }),
  } as unknown as Database;

  return { db, receipts, inserted };
}

describe("order receipts", () => {
  it("records receipt proof with a token hash only", async () => {
    const { db, inserted } = createReceiptDb();

    const result = await recordOrderReceipt(db, {
      orderId: "order_1",
      token: "chk_secret_receipt",
      nowSeconds: 100,
      ttlSeconds: 60,
    });

    expect(result).toEqual({
      tokenHash: await hashOrderReceiptToken("chk_secret_receipt"),
      expiresAt: 160,
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      tokenHash: result.tokenHash,
      orderId: "order_1",
      source: "checkout",
      status: "active",
      expiresAt: 160,
    });
    expect(JSON.stringify(inserted[0])).not.toContain("chk_secret_receipt");
  });

  it("validates active hash-backed receipt rows", async () => {
    const tokenHash = await hashOrderReceiptToken("chk_valid");
    const { db } = createReceiptDb({
      receipt: {
        tokenHash,
        orderId: "order_1",
        source: "checkout",
        status: "active",
        expiresAt: 200,
      },
    });

    await expect(validateOrderReceiptProof(db, {
      orderId: "order_1",
      token: "chk_valid",
      nowSeconds: 100,
    })).resolves.toEqual({
      source: "order_receipts",
      orderId: "order_1",
      tokenHash,
      shouldRepairKv: true,
    });
  });

  it("rejects expired or wrong-order receipt rows without falling back to checkout attempts", async () => {
    const tokenHash = await hashOrderReceiptToken("chk_valid");
    const { db, inserted } = createReceiptDb({
      receipt: {
        tokenHash,
        orderId: "other_order",
        source: "checkout",
        status: "active",
        expiresAt: 90,
      },
      attempt: {
        orderId: "order_1",
        status: "committed",
      },
    });

    await expect(validateOrderReceiptProof(db, {
      orderId: "order_1",
      token: "chk_valid",
      nowSeconds: 100,
    })).resolves.toBeNull();
    expect(inserted).toHaveLength(0);
  });

  it("self-heals from committed checkout attempts when no receipt row exists", async () => {
    const { db, inserted } = createReceiptDb({
      attempt: {
        orderId: "order_1",
        status: "committed",
      },
    });

    const result = await validateOrderReceiptProof(db, {
      orderId: "order_1",
      token: "chk_valid",
      nowSeconds: 100,
    });

    expect(result).toMatchObject({
      source: "checkout_attempts",
      orderId: "order_1",
      shouldRepairKv: true,
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      tokenHash: await hashOrderReceiptToken("chk_valid"),
      orderId: "order_1",
      source: "checkout_attempt",
      status: "active",
    });
  });

  it("keeps processing checkout attempts as temporary proof without writing receipt rows", async () => {
    const { db, inserted } = createReceiptDb({
      attempt: {
        orderId: "order_1",
        status: "processing",
      },
    });

    const result = await validateOrderReceiptProof(db, {
      orderId: "order_1",
      token: "chk_valid",
      nowSeconds: 100,
    });

    expect(result).toMatchObject({
      source: "checkout_attempts",
      orderId: "order_1",
      shouldRepairKv: false,
    });
    expect(inserted).toHaveLength(0);
  });
});
