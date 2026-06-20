import { NotFoundError } from "./api-error";
import type { Database } from "@scalius/database/client";
import { checkoutAttempts, orders } from "@scalius/database/schema";
import { and, eq, or } from "drizzle-orm";

export const RECEIPT_TOKEN_PREFIX = "order_receipt:";
export const RECEIPT_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;

export async function validateReceiptToken(
  kv: KVNamespace | undefined,
  orderId: string,
  token: string | undefined,
  db?: Database,
): Promise<void> {
  if (!token || !token.startsWith("chk_")) {
    throw new NotFoundError("Order receipt not found");
  }

  const raw = kv ? await kv.get(`${RECEIPT_TOKEN_PREFIX}${token}`) : null;

  if (raw) {
    try {
      const data = JSON.parse(raw) as { orderId?: unknown };
      if (data.orderId !== orderId) {
        throw new NotFoundError("Order receipt not found");
      }
      return;
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      throw new NotFoundError("Order receipt not found");
    }
  }

  if (!db) {
    throw new NotFoundError("Order receipt not found");
  }

  const attempt = await db
    .select({
      orderId: checkoutAttempts.orderId,
      status: checkoutAttempts.status,
    })
    .from(checkoutAttempts)
    .where(
      and(
        eq(checkoutAttempts.checkoutToken, token),
        eq(checkoutAttempts.orderId, orderId),
        or(
          eq(checkoutAttempts.status, "committed"),
          eq(checkoutAttempts.status, "processing"),
        ),
      ),
    )
    .get();

  if (!attempt) {
    throw new NotFoundError("Order receipt not found");
  }

  if (attempt.status !== "committed") {
    const order = await db
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.id, orderId))
      .get();

    if (!order) {
      throw new NotFoundError("Order receipt not found");
    }
  }

  await kv?.put(
    `${RECEIPT_TOKEN_PREFIX}${token}`,
    JSON.stringify({ orderId }),
    { expirationTtl: RECEIPT_TOKEN_TTL_SECONDS },
  ).catch((error: unknown) => {
    console.error("[Orders] Failed to repair receipt token KV from D1:", {
      orderId,
      token,
      error,
    });
  });
}
