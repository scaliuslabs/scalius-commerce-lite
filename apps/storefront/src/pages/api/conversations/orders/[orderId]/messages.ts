// Message on an order's thread from the order thread panel (receipt, track
// order, account order). The form action says how the buyer reaches the order
// (`?access=account` uses the session cookie; anything else is a guest whose
// receipt proof is read from its httpOnly cookie and sent to the API only as a
// header). The first message starts the thread.
import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import { crossOriginRefusal, handleConversationMessagePost, orderTarget } from "@/lib/account-inbox-server";

export const prerender = false;

export const POST: APIRoute = async ({ request, params, url }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) return crossOriginRefusal(request);
  const target = orderTarget(params.orderId, url.searchParams.get("access"));
  const fallback = target?.kind === "order" && target.access === "account"
    ? `/account/orders/${encodeURIComponent(target.orderId)}`
    : "/track-order";
  return handleConversationMessagePost(request, target, fallback);
};
