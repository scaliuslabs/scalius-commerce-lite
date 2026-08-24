import type { Database } from "@scalius/database/client";
import { checkoutAttempts, orderReceipts, orders } from "@scalius/database/schema";
import { and, eq, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

export const ORDER_RECEIPT_TOKEN_PREFIX = "order_receipt:";
export const ORDER_RECEIPT_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;

export type OrderReceiptValidationResult = {
  source: "order_receipts" | "checkout_attempts" | "checkout_aggregate";
  orderId: string;
  tokenHash: string;
  shouldRepairKv: boolean;
};

export function isOrderReceiptToken(value: string | undefined): value is string {
  return typeof value === "string" && value.startsWith("chk_");
}

export function createOrderReceiptToken(): string {
  return `chk_${nanoid()}`;
}

export async function hashOrderReceiptToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function recordOrderReceipt(
  db: Database,
  input: {
    orderId: string;
    token: string;
    source?: string;
    nowSeconds?: number;
    ttlSeconds?: number;
  },
): Promise<{ tokenHash: string; expiresAt: number }> {
  const tokenHash = await hashOrderReceiptToken(input.token);
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const expiresAt = nowSeconds + (input.ttlSeconds ?? ORDER_RECEIPT_TOKEN_TTL_SECONDS);

  await db
    .insert(orderReceipts)
    .values({
      tokenHash,
      orderId: input.orderId,
      source: input.source ?? "checkout",
      status: "active",
      expiresAt,
      createdAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    })
    .onConflictDoUpdate({
      target: orderReceipts.tokenHash,
      set: {
        orderId: input.orderId,
        source: input.source ?? "checkout",
        status: "active",
        expiresAt,
        updatedAt: sql`unixepoch()`,
      },
    });

  return { tokenHash, expiresAt };
}

export async function validateOrderReceiptProof(
  db: Database,
  input: {
    orderId: string;
    token: string | undefined;
    nowSeconds?: number;
  },
): Promise<OrderReceiptValidationResult | null> {
  if (!isOrderReceiptToken(input.token)) return null;

  const token = input.token;
  const tokenHash = await hashOrderReceiptToken(token);
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);

  const receipt = await db
    .select({
      orderId: orderReceipts.orderId,
      status: orderReceipts.status,
      expiresAt: orderReceipts.expiresAt,
    })
    .from(orderReceipts)
    .where(eq(orderReceipts.tokenHash, tokenHash))
    .get();

  if (receipt) {
    if (
      receipt.orderId !== input.orderId ||
      receipt.status !== "active" ||
      receipt.expiresAt <= nowSeconds
    ) {
      return null;
    }

    return {
      source: "order_receipts",
      orderId: receipt.orderId,
      tokenHash,
      shouldRepairKv: true,
    };
  }

  const aggregate = await db
    .select({
      orderId: orders.id,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .where(
      and(
        eq(orders.id, input.orderId),
        eq(orders.checkoutReceiptHash, tokenHash),
        eq(orders.checkoutAggregateVersion, 1),
      ),
    )
    .get();
  if (
    aggregate
    && Math.floor(aggregate.createdAt.getTime() / 1_000)
      + ORDER_RECEIPT_TOKEN_TTL_SECONDS > nowSeconds
  ) {
    return {
      source: "checkout_aggregate",
      orderId: aggregate.orderId,
      tokenHash,
      shouldRepairKv: true,
    };
  }

  const attempt = await db
    .select({
      orderId: checkoutAttempts.orderId,
      status: checkoutAttempts.status,
      createdAt: checkoutAttempts.createdAt,
    })
    .from(checkoutAttempts)
    .where(
      and(
        eq(checkoutAttempts.checkoutToken, token),
        eq(checkoutAttempts.orderId, input.orderId),
        or(
          eq(checkoutAttempts.status, "committed"),
          eq(checkoutAttempts.status, "processing"),
        ),
      ),
    )
    .get();

  if (
    !attempt
    || attempt.createdAt + ORDER_RECEIPT_TOKEN_TTL_SECONDS <= nowSeconds
  ) return null;

  if (attempt.status === "committed") {
    await recordOrderReceipt(db, {
      orderId: attempt.orderId,
      token,
      source: "checkout_attempt",
      nowSeconds,
      ttlSeconds: attempt.createdAt + ORDER_RECEIPT_TOKEN_TTL_SECONDS - nowSeconds,
    });
  }

  return {
    source: "checkout_attempts",
    orderId: attempt.orderId,
    tokenHash,
    shouldRepairKv: attempt.status === "committed",
  };
}
