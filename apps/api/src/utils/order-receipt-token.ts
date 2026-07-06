import { NotFoundError } from "./api-error";
import type { Database } from "@scalius/database/client";
import {
  ORDER_RECEIPT_TOKEN_PREFIX,
  ORDER_RECEIPT_TOKEN_TTL_SECONDS,
  hashOrderReceiptToken,
  isOrderReceiptToken,
  validateOrderReceiptProof,
} from "@scalius/core/modules/orders";

export const RECEIPT_TOKEN_PREFIX = ORDER_RECEIPT_TOKEN_PREFIX;
export const RECEIPT_TOKEN_TTL_SECONDS = ORDER_RECEIPT_TOKEN_TTL_SECONDS;

export function getReceiptTokenKvKeyFromHash(tokenHash: string): string {
  return `${RECEIPT_TOKEN_PREFIX}${tokenHash}`;
}

export async function getReceiptTokenKvKey(token: string): Promise<string> {
  return getReceiptTokenKvKeyFromHash(await hashOrderReceiptToken(token));
}

export async function getCheckoutStatusKvKey(token: string): Promise<string> {
  return `checkout_status:${await hashOrderReceiptToken(token)}`;
}

export async function validateReceiptToken(
  kv: KVNamespace | undefined,
  orderId: string,
  token: string | undefined,
  db?: Database,
): Promise<void> {
  if (!isOrderReceiptToken(token)) {
    throw new NotFoundError("Order receipt not found");
  }

  if (db) {
    const result = await validateOrderReceiptProof(db, { orderId, token });
    if (!result) {
      throw new NotFoundError("Order receipt not found");
    }

    if (result.shouldRepairKv) {
      await repairReceiptKv(kv, orderId, result.tokenHash);
    }
    return;
  }

  const raw = kv ? await kv.get(await getReceiptTokenKvKey(token)) : null;
  if (!raw) {
    throw new NotFoundError("Order receipt not found");
  }

  try {
    const data = JSON.parse(raw) as { orderId?: unknown };
    if (data.orderId !== orderId) {
      throw new NotFoundError("Order receipt not found");
    }
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    throw new NotFoundError("Order receipt not found");
  }
}

async function repairReceiptKv(
  kv: KVNamespace | undefined,
  orderId: string,
  tokenHash: string,
): Promise<void> {
  if (!kv) return;

  await kv.put(
    getReceiptTokenKvKeyFromHash(tokenHash),
    JSON.stringify({ orderId }),
    { expirationTtl: RECEIPT_TOKEN_TTL_SECONDS },
  ).catch((error: unknown) => {
    console.error("[Orders] Failed to repair receipt token KV from D1:", {
      orderId,
      tokenHash: tokenHash.slice(0, 12),
      error,
    });
  });
}
