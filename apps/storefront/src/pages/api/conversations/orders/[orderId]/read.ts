import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import { crossOriginRefusal, handleConversationRead } from "@/lib/account-inbox-server";
import { orderTarget } from "@/lib/account-inbox-server";

export const prerender = false;
export const POST: APIRoute = async ({ request, params, url }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) return crossOriginRefusal(request);

  return handleConversationRead(request, orderTarget(params.orderId, url.searchParams.get("access")));
};
