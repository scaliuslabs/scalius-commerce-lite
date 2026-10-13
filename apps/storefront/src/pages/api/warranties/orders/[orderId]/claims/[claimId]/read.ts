import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import { crossOriginRefusal, handleConversationRead } from "@/lib/account-inbox-server";
import { isOrderId } from "@/lib/account-inbox";
import { isWarrantyClaimId } from "@/lib/account-warranties";

export const prerender = false;
export const POST: APIRoute = async ({ request, params }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) return crossOriginRefusal(request);
  const { orderId, claimId } = params;
  return handleConversationRead(request, isOrderId(orderId) && isWarrantyClaimId(claimId) ? { kind: "claim" as const, orderId, claimId } : null);
};
