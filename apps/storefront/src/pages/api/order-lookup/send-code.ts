import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import { readOrderLookupInput } from "@/lib/order-lookup";
import {
  orderCodeFailureResponse,
  orderCodeJsonResponse,
  readOrderCodeFields,
  sendOrderLookupCode,
} from "@/lib/order-lookup-api";

/** Track your order, step 1. Success never says whether an order matched. */
export const POST: APIRoute = async ({ request }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) {
    return orderCodeJsonResponse({ success: false, errorCode: "ORDER_LOOKUP_REQUEST_DENIED" }, 403);
  }

  const fields = await readOrderCodeFields(request);
  const input = readOrderLookupInput(fields?.reference ?? "", fields?.phone ?? "");
  if (!input.ok) {
    return orderCodeJsonResponse({ success: false, errorCode: "VALIDATION_ERROR", field: input.field }, 400);
  }

  const result = await sendOrderLookupCode({ reference: input.reference, phone: input.phone });
  return result.ok
    ? orderCodeJsonResponse({ success: true, ...result.data })
    : orderCodeFailureResponse(result.failure, { includeMessage: true });
};
