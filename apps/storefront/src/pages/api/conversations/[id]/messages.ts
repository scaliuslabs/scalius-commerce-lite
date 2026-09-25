// Reply on an account conversation (a store thread or an owned order's thread).
// Works as a plain form post (303 back to the thread) and as an enhanced fetch
// (JSON with the re-rendered messages). Images are uploaded first, then the
// message is posted with their ids.
import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import { crossOriginRefusal, handleConversationMessagePost } from "@/lib/account-inbox-server";
import { isConversationId } from "@/lib/account-inbox";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) return crossOriginRefusal(request);
  const conversationId = isConversationId(params.id) ? params.id : null;
  return handleConversationMessagePost(
    request,
    conversationId ? { kind: "thread", conversationId } : null,
    conversationId ? `/account/inbox/${encodeURIComponent(conversationId)}` : "/account/inbox",
  );
};
