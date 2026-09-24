import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import {
  orderCodeFailureResponse,
  orderCodeJsonResponse,
  readOrderCodeFields,
  sendPaymentRecoveryCode,
} from "@/lib/order-lookup-api";

const ACCEPTED_RESULT_CODE = "PAYMENT_RECOVERY_CODE_REQUEST_ACCEPTED";

export const POST: APIRoute = async ({ request }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) {
    return orderCodeJsonResponse({ success: false, errorCode: "PAYMENT_RECOVERY_REQUEST_DENIED" }, 403);
  }

  const fields = await readOrderCodeFields(request);
  if (!fields) {
    return orderCodeJsonResponse({ success: false, errorCode: "PAYMENT_RECOVERY_INVALID_REQUEST" }, 400);
  }
  // Same neutral answer as an ineligible order: the link alone reveals nothing.
  if (!fields.orderId) return orderCodeJsonResponse({ success: true, resultCode: ACCEPTED_RESULT_CODE });

  const result = await sendPaymentRecoveryCode({ orderId: fields.orderId, channel: fields.channel });
  return result.ok
    ? orderCodeJsonResponse({ success: true, resultCode: ACCEPTED_RESULT_CODE, ...result.data })
    : orderCodeFailureResponse(result.failure, { includeMessage: false });
};
