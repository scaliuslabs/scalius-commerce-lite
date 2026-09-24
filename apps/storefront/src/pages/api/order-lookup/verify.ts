import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import { readOrderLookupInput } from "@/lib/order-lookup";
import {
  orderCodeFailureResponse,
  orderCodeJsonResponse,
  readOrderCodeFields,
  verifiedReceiptResponse,
  verifyOrderLookupCode,
} from "@/lib/order-lookup-api";

/** Track your order, step 2: a correct code opens the receipt on this device. */
export const POST: APIRoute = async ({ request }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) {
    return orderCodeJsonResponse({ success: false, errorCode: "ORDER_LOOKUP_REQUEST_DENIED" }, 403);
  }

  const fields = await readOrderCodeFields(request);
  const input = readOrderLookupInput(fields?.reference ?? "", fields?.phone ?? "");
  if (!input.ok || !fields?.code) {
    return orderCodeJsonResponse({
      success: false,
      errorCode: "VALIDATION_ERROR",
      field: input.ok ? "code" : input.field,
    }, 400);
  }

  const result = await verifyOrderLookupCode({ reference: input.reference, phone: input.phone, code: fields.code });
  return result.ok
    ? verifiedReceiptResponse(result.data, "json")
    : orderCodeFailureResponse(result.failure);
};
