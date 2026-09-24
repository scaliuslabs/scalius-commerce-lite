import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import {
  orderCodeFailureResponse,
  orderCodeJsonResponse,
  readOrderCodeFields,
  verifiedReceiptResponse,
  verifyPaymentRecoveryCode,
} from "@/lib/order-lookup-api";

export const POST: APIRoute = async ({ request }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) {
    return orderCodeJsonResponse({ success: false, errorCode: "PAYMENT_RECOVERY_REQUEST_DENIED" }, 403);
  }

  const fields = await readOrderCodeFields(request);
  if (!fields?.orderId || !fields.code) {
    return orderCodeJsonResponse({ success: false, errorCode: "PAYMENT_RECOVERY_INVALID_VERIFICATION" }, 400);
  }

  const result = await verifyPaymentRecoveryCode({ orderId: fields.orderId, code: fields.code });
  return result.ok
    ? verifiedReceiptResponse(result.data, "json")
    : orderCodeFailureResponse(result.failure);
};
