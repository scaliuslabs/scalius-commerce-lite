// The buyer closes one of their conversations: a plain form post from the
// thread page (works without JavaScript), answered with a redirect back to the
// thread and its outcome flag. Their next message opens it again.
import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import { closeConversation, conversationRedirect, crossOriginRefusal } from "@/lib/account-inbox-server";
import { isConversationId, withConversationStatus } from "@/lib/account-inbox";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) return crossOriginRefusal(request);
  if (!isConversationId(params.id)) return conversationRedirect(withConversationStatus("/account/inbox", "missing"));
  const result = await closeConversation(request, params.id);
  return conversationRedirect(withConversationStatus(`/account/inbox/${encodeURIComponent(params.id)}`, result.flag, "conversation", result.retryAfterSeconds));
};
