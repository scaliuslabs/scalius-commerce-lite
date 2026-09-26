// A guest's reply in a warranty claim's thread (the claim page). The order's
// receipt proof is read from its httpOnly cookie and reaches the API only as a
// header; the URL carries the order and claim ids alone. (Signed-in owners
// answer a claim in the Inbox.)
import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import { isOrderId } from "@/lib/account-inbox";
import { crossOriginRefusal, handleConversationMessagePost } from "@/lib/account-inbox-server";
import { isWarrantyClaimId } from "@/lib/account-warranties";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) return crossOriginRefusal(request);
  const { orderId, claimId } = params;
  const target = isOrderId(orderId) && isWarrantyClaimId(claimId) ? { kind: "claim" as const, orderId, claimId } : null;
  const fallback = target
    ? `/warranty-claims/${encodeURIComponent(target.orderId)}/${encodeURIComponent(target.claimId)}`
    : "/track-order";
  return handleConversationMessagePost(request, target, fallback);
};
