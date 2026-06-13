import { NotFoundError } from "./api-error";

export const RECEIPT_TOKEN_PREFIX = "order_receipt:";
export const RECEIPT_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;

export async function validateReceiptToken(
  kv: KVNamespace | undefined,
  orderId: string,
  token: string | undefined,
): Promise<void> {
  if (!kv || !token || !token.startsWith("chk_")) {
    throw new NotFoundError("Order receipt not found");
  }

  const raw = await kv.get(`${RECEIPT_TOKEN_PREFIX}${token}`);
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
