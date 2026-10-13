import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import { crossOriginRefusal, handleConversationRead } from "@/lib/account-inbox-server";
import { isConversationId } from "@/lib/account-inbox";

export const prerender = false;
export const POST: APIRoute = async ({ request, params }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) return crossOriginRefusal(request);
  const conversationId = isConversationId(params.id) ? params.id : null;
  return handleConversationRead(request, conversationId ? { kind: "thread", conversationId } : null);
};
